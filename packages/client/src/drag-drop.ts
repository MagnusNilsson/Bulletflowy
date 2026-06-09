import { updateNode } from './api.js';
import { showSaved, showSaveError } from './save-indicator.js';
import { state, findNode, findParentOf } from './state.js';
import { renderTree, moveNodeElInDOM } from './tree-renderer.js';

interface VisibleNode {
  id: string;
  depth: number;         // 1 = child of display root
  top: number;           // document-relative top of .node-self
  bottom: number;        // document-relative bottom of .node-self
}

interface DropTarget {
  parentId: string;
  afterId?: string;
  beforeId?: string;
  depth: number;
}

interface DragState {
  nodeId: string;
  nodeEl: HTMLElement;
  ghost: HTMLElement;
  indicator: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  visibleNodes: VisibleNode[];
  indent: number;
  baseLeft: number;
  /** X offset of a bullet's center within its `.node-self`. The drop dot is placed at
   *  `baseLeft + (depth-1)*indent + bulletOffset` so it lines up with the actual bullet column. */
  bulletOffset: number;
  containerRight: number;
  initialScrollY: number;
}

let dragState: DragState | null = null;
let treeChangedCallback: (() => void) | null = null;

export function initDragDrop(container: HTMLElement, onTreeChanged?: () => void) {
  if (onTreeChanged) treeChangedCallback = onTreeChanged;
  container.addEventListener('pointerdown', onPointerDown);
}

function onPointerDown(e: PointerEvent) {
  const handle = (e.target as HTMLElement).closest('.node-bullet') as HTMLElement | null;
  if (!handle) return;

  const nodeEl = handle.closest('.node') as HTMLElement;
  if (!nodeEl) return;

  const nodeId = nodeEl.dataset.id;
  if (!nodeId) return;

  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  const textEl = nodeEl.querySelector('.node-text') as HTMLElement;
  ghost.textContent = textEl?.textContent ?? '';
  ghost.style.left = `${e.clientX + 12}px`;
  ghost.style.top = `${e.clientY - 12}px`;

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';
  indicator.style.display = 'none';

  dragState = {
    nodeId,
    nodeEl,
    ghost,
    indicator,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    longPressTimer: null,
    visibleNodes: [],
    indent: 24,
    baseLeft: 0,
    bulletOffset: 0,
    containerRight: 0,
    initialScrollY: 0,
  };

  // For touch: require long press
  if (e.pointerType === 'touch') {
    dragState.longPressTimer = setTimeout(() => {
      if (dragState) {
        activateDrag();
      }
    }, 300);
  }

  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('keydown', onDragKeyDown);
  document.addEventListener('contextmenu', onDragContextMenu);
}

function activateDrag() {
  if (!dragState) return;
  dragState.active = true;
  dragState.nodeEl.classList.add('dragging');
  document.body.appendChild(dragState.ghost);
  document.body.appendChild(dragState.indicator);

  // Cache visible nodes and geometry
  dragState.visibleNodes = buildVisibleNodes(dragState.nodeId);
  dragState.indent = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--node-indent')) || 24;
  dragState.initialScrollY = window.scrollY;

  // Compute baseLeft and bulletOffset from the first visible node at depth 1
  const depthOneNode = dragState.visibleNodes.find(n => n.depth === 1);
  if (depthOneNode) {
    const el = document.querySelector(`.node[data-id="${CSS.escape(depthOneNode.id)}"]`);
    const selfEl = el?.querySelector(':scope > .node-self') as HTMLElement | null;
    if (selfEl) {
      const selfRect = selfEl.getBoundingClientRect();
      dragState.baseLeft = selfRect.left;
      const bulletEl = selfEl.querySelector(':scope > .node-bullet') as HTMLElement | null;
      if (bulletEl) {
        const bulletRect = bulletEl.getBoundingClientRect();
        dragState.bulletOffset = (bulletRect.left + bulletRect.width / 2) - selfRect.left;
      }
    }
  }

  const container = document.getElementById('tree-container');
  if (container) {
    dragState.containerRight = container.getBoundingClientRect().right;
  }
}

function buildVisibleNodes(draggedId: string): VisibleNode[] {
  const nodes: VisibleNode[] = [];
  const container = document.getElementById('tree-container');
  if (!container) return nodes;

  const draggedEl = container.querySelector(`.node[data-id="${CSS.escape(draggedId)}"]`);
  const allNodeEls = container.querySelectorAll('.node');
  const scrollY = window.scrollY;

  for (const el of allNodeEls) {
    const htmlEl = el as HTMLElement;
    const id = htmlEl.dataset.id;
    if (!id) continue;

    // Skip dragged node and its descendants
    if (htmlEl === draggedEl || (draggedEl && draggedEl.contains(htmlEl))) continue;

    const selfEl = htmlEl.querySelector(':scope > .node-self') as HTMLElement;
    if (!selfEl) continue;

    // Compute depth by counting .node-children ancestors up to container
    let depth = 0;
    let parent = htmlEl.parentElement;
    while (parent && parent !== container) {
      if (parent.classList.contains('node-children')) depth++;
      parent = parent.parentElement;
    }
    depth += 1; // depth 1 = child of display root

    const rect = selfEl.getBoundingClientRect();
    nodes.push({
      id,
      depth,
      top: rect.top + scrollY,       // document-relative
      bottom: rect.bottom + scrollY,  // document-relative
    });
  }

  return nodes;
}

function findGap(clientY: number, nodes: VisibleNode[], scrollDelta: number): { above: VisibleNode | null; below: VisibleNode | null } {
  if (nodes.length === 0) return { above: null, below: null };

  const docY = clientY + window.scrollY;

  for (let i = 0; i < nodes.length; i++) {
    const midY = (nodes[i].top + nodes[i].bottom) / 2 + scrollDelta;
    if (docY < midY) {
      return { above: i > 0 ? nodes[i - 1] : null, below: nodes[i] };
    }
  }

  return { above: nodes[nodes.length - 1], below: null };
}

function getDepthRange(above: VisibleNode | null, below: VisibleNode | null): { min: number; max: number } {
  const maxDepth = above ? above.depth + 1 : 1;
  const minDepth = below ? below.depth : 1;

  return { min: Math.min(minDepth, maxDepth), max: maxDepth };
}

function computeDropTarget(
  above: VisibleNode | null,
  below: VisibleNode | null,
  depth: number,
  visibleNodes: VisibleNode[],
): DropTarget | null {
  const displayRootId = state.zoomedNodeId ?? state.root?.id ?? '';
  if (!displayRootId) return null;

  // Gap above first node
  if (!above) {
    return { parentId: displayRootId, beforeId: below?.id, depth };
  }

  // Becoming first child of nodeAbove
  if (depth === above.depth + 1) {
    // If below is a visible direct child of above, insert before it
    if (below && below.depth === depth) {
      return { parentId: above.id, beforeId: below.id, depth };
    }
    // Children not visible (collapsed) or no children — look up from tree data
    if (state.root) {
      const aboveNode = findNode(state.root, above.id);
      if (aboveNode && aboveNode.children.length > 0) {
        return { parentId: above.id, beforeId: aboveNode.children[0].id, depth };
      }
    }
    // Leaf node — just set parentId (no siblings to position relative to)
    return { parentId: above.id, depth };
  }

  // depth <= above.depth: find ancestor at target depth by scanning backward
  const aboveIdx = visibleNodes.indexOf(above);

  let ancestorAtDepth: VisibleNode = above;
  for (let i = aboveIdx; i >= 0; i--) {
    if (visibleNodes[i].depth === depth) {
      ancestorAtDepth = visibleNodes[i];
      break;
    }
    if (visibleNodes[i].depth < depth) break;
  }

  // parentId = ancestor's parent. For depth 1, that's displayRoot.
  if (depth === 1) {
    return { parentId: displayRootId, afterId: ancestorAtDepth.id, depth };
  }

  // Find parent: scan backward from ancestor for node at depth-1
  const ancestorIdx = visibleNodes.indexOf(ancestorAtDepth);
  for (let i = ancestorIdx - 1; i >= 0; i--) {
    if (visibleNodes[i].depth === depth - 1) {
      return { parentId: visibleNodes[i].id, afterId: ancestorAtDepth.id, depth };
    }
    if (visibleNodes[i].depth < depth - 1) break;
  }

  // Fallback
  return { parentId: displayRootId, afterId: ancestorAtDepth.id, depth };
}

function onPointerMove(e: PointerEvent) {
  if (!dragState) return;

  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;

  // Activate on movement threshold (mouse)
  if (!dragState.active && Math.sqrt(dx * dx + dy * dy) > 5) {
    if (dragState.longPressTimer) {
      clearTimeout(dragState.longPressTimer);
      dragState.longPressTimer = null;
    }
    if (e.pointerType !== 'touch') {
      activateDrag();
    }
  }

  if (!dragState.active) return;

  // Update ghost position
  dragState.ghost.style.left = `${e.clientX + 12}px`;
  dragState.ghost.style.top = `${e.clientY - 12}px`;

  // Scroll delta since drag started (rects are document-relative based on initial scroll)
  const scrollDelta = 0; // rects stored as document-relative, so no delta needed

  // Find the gap
  const { above, below } = findGap(e.clientY, dragState.visibleNodes, scrollDelta);
  if (!above && !below) {
    dragState.indicator.style.display = 'none';
    return;
  }

  // Compute valid depth range
  const { min, max } = getDepthRange(above, below);

  // Map clientX to depth, anchored on the bullet column so the cursor "lives in"
  // the column it's targeting (rather than the row's left edge, which sits ~54px left of any bullet).
  const rawDepth = 1 + (e.clientX - dragState.baseLeft - dragState.bulletOffset) / dragState.indent;
  const chosenDepth = Math.max(min, Math.min(max, Math.round(rawDepth)));

  // Compute drop target
  const target = computeDropTarget(above, below, chosenDepth, dragState.visibleNodes);
  if (!target) {
    dragState.indicator.style.display = 'none';
    return;
  }

  // Don't allow dropping into self
  if (target.parentId === dragState.nodeId) {
    dragState.indicator.style.display = 'none';
    return;
  }

  // Position indicator: dot lands on the bullet column for the chosen depth,
  // line extends right to the container edge.
  const gapY = above
    ? (above.bottom - window.scrollY)   // viewport-relative bottom of node above
    : (below!.top - window.scrollY);    // viewport-relative top of node below

  const indicatorLeft = dragState.baseLeft + (chosenDepth - 1) * dragState.indent + dragState.bulletOffset;
  const indicatorWidth = dragState.containerRight - indicatorLeft;

  dragState.indicator.style.display = 'block';
  dragState.indicator.style.top = `${gapY}px`;
  dragState.indicator.style.left = `${indicatorLeft}px`;
  dragState.indicator.style.width = `${Math.max(indicatorWidth, 40)}px`;

  // Store drop target on indicator
  dragState.indicator.dataset.parentId = target.parentId;
  dragState.indicator.dataset.afterId = target.afterId ?? '';
  dragState.indicator.dataset.beforeId = target.beforeId ?? '';

  // Auto-scroll near edges
  const scrollZone = 60;
  const scrollContainer = document.documentElement;
  if (e.clientY < scrollZone) {
    scrollContainer.scrollTop -= 8;
  } else if (e.clientY > window.innerHeight - scrollZone) {
    scrollContainer.scrollTop += 8;
  }
}

function suppressClick(e: Event) {
  e.stopPropagation();
  e.preventDefault();
}

function removeDragListeners() {
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', onPointerUp);
  document.removeEventListener('keydown', onDragKeyDown);
  document.removeEventListener('contextmenu', onDragContextMenu);
}

function cancelDrag() {
  removeDragListeners();
  if (!dragState) return;
  if (dragState.longPressTimer) clearTimeout(dragState.longPressTimer);
  if (dragState.active) {
    dragState.nodeEl.classList.remove('dragging');
    dragState.ghost.remove();
    dragState.indicator.remove();
  }
  dragState = null;
}

function onDragKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && dragState) {
    e.preventDefault();
    cancelDrag();
  }
}

function onDragContextMenu(e: Event) {
  if (dragState) {
    e.preventDefault();
    cancelDrag();
  }
}

async function onPointerUp(_e: PointerEvent) {
  removeDragListeners();

  if (!dragState) return;

  if (dragState.longPressTimer) {
    clearTimeout(dragState.longPressTimer);
  }

  if (!dragState.active) {
    dragState = null;
    return;
  }

  // Suppress the click that follows pointerup so it doesn't zoom into a node
  document.addEventListener('click', suppressClick, { capture: true, once: true });

  dragState.nodeEl.classList.remove('dragging');
  dragState.ghost.remove();

  const parentId = dragState.indicator.dataset.parentId;
  const afterId = dragState.indicator.dataset.afterId || undefined;
  const beforeId = dragState.indicator.dataset.beforeId || undefined;
  dragState.indicator.remove();

  const nodeId = dragState.nodeId;
  dragState = null;

  if (!parentId || !state.root) return;

  const node = findNode(state.root, nodeId);
  const oldParent = findParentOf(state.root, nodeId);
  const newParent = findNode(state.root, parentId);
  if (!node || !oldParent || !newParent) return;

  const oldIndex = oldParent.children.findIndex(c => c.id === nodeId);
  if (oldIndex === -1) return;

  oldParent.children.splice(oldIndex, 1);

  let newIndex: number;
  if (afterId) {
    const idx = newParent.children.findIndex(c => c.id === afterId);
    newIndex = idx === -1 ? newParent.children.length : idx + 1;
  } else if (beforeId) {
    const idx = newParent.children.findIndex(c => c.id === beforeId);
    newIndex = idx === -1 ? newParent.children.length : idx;
  } else {
    newIndex = newParent.children.length;
  }

  newParent.children.splice(newIndex, 0, node);

  // Incremental DOM: move the existing element (with its subtree) instead of rebuilding everything.
  if (!moveNodeElInDOM(newParent, nodeId)) renderTree();

  try {
    const update: Parameters<typeof updateNode>[1] = { parentId };
    if (afterId) {
      update.afterId = afterId;
    } else if (beforeId) {
      update.beforeId = beforeId;
    }

    await updateNode(nodeId, update);
    showSaved();
  } catch (err: any) {
    const failedIdx = newParent.children.findIndex(c => c.id === nodeId);
    if (failedIdx !== -1) newParent.children.splice(failedIdx, 1);
    oldParent.children.splice(oldIndex, 0, node);
    renderTree();
    showSaveError('Move failed: ' + err.message);
    treeChangedCallback?.();
  }
}
