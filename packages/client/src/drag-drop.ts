import { updateNode } from './api.js';
import { showSaved, showSaveError } from './save-indicator.js';

interface DragState {
  nodeId: string;
  nodeEl: HTMLElement;
  ghost: HTMLElement;
  indicator: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
}

let dragState: DragState | null = null;
let treeChangedCallback: (() => void) | null = null;

export function setDragTreeChanged(cb: () => void) {
  treeChangedCallback = cb;
}

export function initDragDrop(container: HTMLElement) {
  // Use event delegation on the container
  container.addEventListener('pointerdown', onPointerDown);
}

function onPointerDown(e: PointerEvent) {
  const handle = (e.target as HTMLElement).closest('.node-drag-handle') as HTMLElement | null;
  if (!handle) return;

  const nodeEl = handle.closest('.node') as HTMLElement;
  if (!nodeEl) return;

  const nodeId = nodeEl.dataset.id;
  if (!nodeId) return;

  e.preventDefault();

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
  };

  // For touch: require long press
  if (e.pointerType === 'touch') {
    dragState.longPressTimer = setTimeout(() => {
      if (dragState) {
        activateDrag();
      }
    }, 300);
  } else {
    // For mouse: activate on move threshold
  }

  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
}

function activateDrag() {
  if (!dragState) return;
  dragState.active = true;
  dragState.nodeEl.classList.add('dragging');
  document.body.appendChild(dragState.ghost);
  document.body.appendChild(dragState.indicator);
  (dragState.nodeEl as HTMLElement).setPointerCapture?.(0);
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

  // Find drop target
  dragState.ghost.style.pointerEvents = 'none';
  dragState.indicator.style.pointerEvents = 'none';
  const elementBelow = document.elementFromPoint(e.clientX, e.clientY);
  dragState.ghost.style.pointerEvents = '';

  const targetNodeEl = elementBelow?.closest('.node') as HTMLElement | null;
  if (!targetNodeEl || targetNodeEl === dragState.nodeEl || targetNodeEl.closest(`[data-id="${CSS.escape(dragState.nodeId)}"]`)) {
    dragState.indicator.style.display = 'none';
    return;
  }

  // Position the drop indicator
  const selfEl = targetNodeEl.querySelector(':scope > .node-self') as HTMLElement;
  if (!selfEl) return;

  const rect = selfEl.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const isBelow = e.clientY > midY;

  const y = isBelow ? rect.bottom : rect.top;
  const container = document.getElementById('tree-container')!;
  const containerRect = container.getBoundingClientRect();

  dragState.indicator.style.display = 'block';
  dragState.indicator.style.top = `${y - containerRect.top + container.scrollTop}px`;
  dragState.indicator.style.left = `${rect.left - containerRect.left}px`;
  dragState.indicator.style.width = `${rect.width}px`;
  dragState.indicator.dataset.targetId = targetNodeEl.dataset.id;
  dragState.indicator.dataset.position = isBelow ? 'after' : 'before';

  // Auto-scroll near edges
  const scrollZone = 60;
  const scrollContainer = document.documentElement;
  if (e.clientY < scrollZone) {
    scrollContainer.scrollTop -= 8;
  } else if (e.clientY > window.innerHeight - scrollZone) {
    scrollContainer.scrollTop += 8;
  }
}

async function onPointerUp(_e: PointerEvent) {
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', onPointerUp);

  if (!dragState) return;

  if (dragState.longPressTimer) {
    clearTimeout(dragState.longPressTimer);
  }

  if (!dragState.active) {
    dragState = null;
    return;
  }

  dragState.nodeEl.classList.remove('dragging');
  dragState.ghost.remove();

  const targetId = dragState.indicator.dataset.targetId;
  const position = dragState.indicator.dataset.position;
  dragState.indicator.remove();

  const nodeId = dragState.nodeId;
  dragState = null;

  if (!targetId || !position) return;

  // Determine new parent and position
  const targetEl = document.querySelector(`.node[data-id="${CSS.escape(targetId)}"]`) as HTMLElement;
  if (!targetEl) return;

  const targetParent = targetEl.closest('.node-children')?.closest('.node') as HTMLElement | null;
  const parentId = targetParent?.dataset.id;

  if (!parentId) {
    // Target is top-level — parent is the zoomed/root node
    // We can't easily get the root ID from DOM, so just reload
    // For now, use the PATCH approach with parentId + position from server
  }

  try {
    // Simple approach: move node to be a sibling of the target
    // We need the target's parentId, so we'll use PATCH with the target's parent
    // This is a simplification — a full implementation would calculate fractional positions
    // For now, just use the move API in the right direction or PATCH
    // TODO: enhance with proper position calculation
    // For MVP, after drop we just reload the tree
    if (targetId && nodeId !== targetId) {
      // Get target node's parent from DOM
      const targetNodeChildren = targetEl.parentElement;
      const targetParentNode = targetNodeChildren?.closest('.node') as HTMLElement | null;
      const newParentId = targetParentNode?.dataset.id;

      if (newParentId) {
        await updateNode(nodeId, { parentId: newParentId });
        showSaved();
        treeChangedCallback?.();
      }
    }
  } catch (err: any) {
    showSaveError('Move failed: ' + err.message);
  }
}
