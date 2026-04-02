import { updateNode } from './api.js';
import { showSaved, showSaveError } from './save-indicator.js';
import { state } from './state.js';

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
  document.addEventListener('keydown', onDragKeyDown);
  document.addEventListener('contextmenu', onDragContextMenu);
}

function activateDrag() {
  if (!dragState) return;
  dragState.active = true;
  dragState.nodeEl.classList.add('dragging');
  document.body.appendChild(dragState.ghost);
  document.body.appendChild(dragState.indicator);
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

  dragState.indicator.style.display = 'block';
  dragState.indicator.style.top = `${isBelow ? rect.bottom : rect.top}px`;
  dragState.indicator.style.left = `${rect.left}px`;
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

  const targetId = dragState.indicator.dataset.targetId;
  const position = dragState.indicator.dataset.position;
  dragState.indicator.remove();

  const nodeId = dragState.nodeId;
  dragState = null;

  if (!targetId || !position || nodeId === targetId) return;

  const targetEl = document.querySelector(`.node[data-id="${CSS.escape(targetId)}"]`) as HTMLElement;
  if (!targetEl) return;

  // Find the target's parent ID from the DOM, or fall back to the display root
  const targetChildrenContainer = targetEl.parentElement; // .node-children
  const targetParentNode = targetChildrenContainer?.closest('.node') as HTMLElement | null;
  const displayRootId = state.zoomedNodeId ?? state.root?.id;
  const parentId = targetParentNode?.dataset.id ?? displayRootId;

  if (!parentId) return;

  try {
    const update: Parameters<typeof updateNode>[1] = { parentId };

    if (position === 'after') {
      update.afterId = targetId;
    } else {
      update.beforeId = targetId;
    }

    await updateNode(nodeId, update);
    showSaved();
    treeChangedCallback?.();
  } catch (err: any) {
    showSaveError('Move failed: ' + err.message);
  }
}
