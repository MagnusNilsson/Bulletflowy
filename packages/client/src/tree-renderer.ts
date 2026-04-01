import type { TreeNode } from '@bulletflowy/shared';
import { state, findNode, getBreadcrumbs, persistCollapsedIds } from './state.js';
import { updateNode, createNode, deleteNode, moveNode, splitNode } from './api.js';
import { showSaved, showSaveError } from './save-indicator.js';
import { initDragDrop } from './drag-drop.js';

let debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let onTreeChanged: (() => void) | null = null;

export function setOnTreeChanged(cb: () => void) {
  onTreeChanged = cb;
}

function getContainer(): HTMLElement {
  return document.getElementById('tree-container')!;
}

export function renderTree() {
  const container = getContainer();
  while (container.firstChild) container.removeChild(container.firstChild);

  if (!state.root) return;

  const displayRoot = state.zoomedNodeId
    ? findNode(state.root, state.zoomedNodeId)
    : state.root;

  if (!displayRoot) return;

  renderBreadcrumbs(displayRoot);

  const visibleChildren = displayRoot.children.filter(
    c => state.showCompleted || c.status !== 'completed'
  );

  if (visibleChildren.length === 0) {
    container.appendChild(renderEmptyPlaceholder(displayRoot.id));
  } else {
    for (const child of visibleChildren) {
      container.appendChild(renderNode(child));
    }
  }

  initDragDrop(container);

  // Restore focus
  if (state.focusedNodeId) {
    const textEl = container.querySelector(
      `.node[data-id="${CSS.escape(state.focusedNodeId)}"] > .node-self .node-text`
    ) as HTMLElement | null;
    if (textEl) {
      textEl.focus();
      textEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const range = document.createRange();
      const sel = window.getSelection();
      if (sel && textEl.childNodes.length > 0) {
        range.selectNodeContents(textEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }
}

function renderNode(node: TreeNode): HTMLElement {
  const el = document.createElement('div');
  el.className = 'node';
  el.dataset.id = node.id;
  el.dataset.status = node.status;

  if (node.status === 'completed') {
    el.classList.add('completed');
    if (!state.showCompleted) {
      el.classList.add('hidden-completed');
    }
  }

  const hasVisibleChildren = node.children.some(
    c => state.showCompleted || c.status !== 'completed'
  );
  if (hasVisibleChildren) el.classList.add('has-children');

  const isCollapsed = state.collapsedIds.has(node.id);
  if (isCollapsed && hasVisibleChildren) el.classList.add('collapsed');

  // Self row (context dots + bullet + text)
  const selfEl = document.createElement('div');
  selfEl.className = 'node-self';
  if (state.focusedNodeId === node.id) {
    selfEl.classList.add('focused');
  }

  // Three-dot context menu trigger (replaces drag handle visually)
  const dotsBtn = document.createElement('div');
  dotsBtn.className = 'node-dots';
  dotsBtn.textContent = '\u2026';
  dotsBtn.setAttribute('tabindex', '-1');
  dotsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showContextMenu(node, e.clientX, e.clientY);
  });
  selfEl.appendChild(dotsBtn);

  // Collapse/expand triangle (only for nodes with children)
  const collapseBtn = document.createElement('div');
  collapseBtn.className = 'node-collapse';
  if (hasVisibleChildren) {
    collapseBtn.classList.add('visible');
    if (isCollapsed) collapseBtn.classList.add('is-collapsed');
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse(node.id);
    });
  }
  selfEl.appendChild(collapseBtn);

  // Drag handle (hidden, used by drag-drop via class)
  const dragHandle = document.createElement('div');
  dragHandle.className = 'node-drag-handle';
  dragHandle.textContent = '\u2807';
  dragHandle.setAttribute('tabindex', '-1');
  selfEl.appendChild(dragHandle);

  // Bullet
  const bullet = document.createElement('div');
  bullet.className = 'node-bullet';
  bullet.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomTo(node.id);
  });
  selfEl.appendChild(bullet);

  // Text (contenteditable)
  const textEl = document.createElement('span');
  textEl.className = 'node-text';
  textEl.contentEditable = 'true';
  textEl.textContent = node.text;
  textEl.spellcheck = true;

  // Focus tracking
  textEl.addEventListener('focus', () => {
    state.focusedNodeId = node.id;
    document.querySelectorAll('.node-self.focused').forEach(el => el.classList.remove('focused'));
    selfEl.classList.add('focused');
  });

  // Enter: context-sensitive node creation
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      const id = node.id;
      // Flush any pending save
      if (debounceTimers.has(id)) {
        clearTimeout(debounceTimers.get(id)!);
        debounceTimers.delete(id);
      }
      handleEnter(node, textEl);
    }
  });

  // Debounced save on input
  textEl.addEventListener('input', () => {
    const id = node.id;
    if (debounceTimers.has(id)) clearTimeout(debounceTimers.get(id)!);
    debounceTimers.set(id, setTimeout(() => {
      debounceTimers.delete(id);
      const newText = textEl.textContent ?? '';
      node.text = newText;
      updateNode(id, { text: newText })
        .then(() => showSaved())
        .catch((err) => showSaveError('Save failed: ' + err.message));
    }, 300));
  });

  selfEl.appendChild(textEl);
  el.appendChild(selfEl);

  // Description (below the text, aligned with text start)
  if (node.description) {
    const descEl = document.createElement('div');
    descEl.className = 'node-description';
    descEl.textContent = node.description;
    el.appendChild(descEl);
  }

  // Children (hidden when collapsed)
  if (hasVisibleChildren && !isCollapsed) {
    const childrenEl = document.createElement('div');
    childrenEl.className = 'node-children';
    for (const child of node.children) {
      if (!state.showCompleted && child.status === 'completed') continue;
      childrenEl.appendChild(renderNode(child));
    }
    el.appendChild(childrenEl);
  }

  return el;
}

function renderEmptyPlaceholder(parentId: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'empty-placeholder';

  const bullet = document.createElement('span');
  bullet.className = 'node-bullet';
  el.appendChild(bullet);

  const textEl = document.createElement('span');
  textEl.className = 'node-text empty-text';
  textEl.contentEditable = 'true';
  textEl.dataset.placeholder = 'Type to add a new item...';

  textEl.addEventListener('focus', () => {
    el.classList.add('focused');
  });

  textEl.addEventListener('blur', () => {
    el.classList.remove('focused');
  });

  textEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = textEl.textContent?.trim() ?? '';
      if (!text) return;
      try {
        const created = await createNode({ parentId, text });
        showSaved();
        state.focusedNodeId = created.id;
        onTreeChanged?.();
      } catch (err: any) {
        showSaveError('Create failed: ' + err.message);
      }
    }
  });

  el.appendChild(textEl);
  requestAnimationFrame(() => textEl.focus());

  return el;
}

function renderBreadcrumbs(displayRoot: TreeNode) {
  const breadcrumbsEl = document.getElementById('breadcrumbs')!;
  while (breadcrumbsEl.firstChild) breadcrumbsEl.removeChild(breadcrumbsEl.firstChild);

  if (!state.root || !state.zoomedNodeId) {
    breadcrumbsEl.textContent = state.root?.text ?? '';
    return;
  }

  const path = getBreadcrumbs(state.root, state.zoomedNodeId);

  path.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'separator';
      sep.textContent = ' > ';
      breadcrumbsEl.appendChild(sep);
    }

    if (i < path.length - 1) {
      const link = document.createElement('a');
      link.textContent = crumb.text || 'Root';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (crumb.id === state.root!.id) {
          zoomTo(null);
        } else {
          zoomTo(crumb.id);
        }
      });
      breadcrumbsEl.appendChild(link);
    } else {
      const span = document.createElement('span');
      span.textContent = crumb.text;
      breadcrumbsEl.appendChild(span);
    }
  });
}

export function zoomTo(nodeId: string | null) {
  state.zoomedNodeId = nodeId;
  if (nodeId) {
    window.location.hash = nodeId;
  } else {
    history.replaceState(null, '', window.location.pathname);
  }
  renderTree();
}

async function handleEnter(node: TreeNode, textEl: HTMLElement) {
  const fullText = textEl.textContent ?? '';
  const cursorOffset = getCursorOffset(textEl);
  const atStart = cursorOffset === 0;
  const atEnd = cursorOffset >= fullText.length;
  const hasChildren = node.children.length > 0;

  if (!state.root) return;
  const parent = findParentOf(state.root, node.id);
  if (!parent) return;

  try {
    if (atStart && fullText.length > 0) {
      // Cursor at start: create empty sibling ABOVE
      const created = await createNode({ parentId: parent.id, text: '', beforeId: node.id });
      showSaved();
      // Keep focus on the current node (the new one is above)
      state.focusedNodeId = node.id;
      onTreeChanged?.();
    } else if (atEnd && hasChildren && !state.collapsedIds.has(node.id)) {
      // Cursor at end, node has visible children: create empty first child
      await updateNode(node.id, { text: fullText }); // ensure saved
      const created = await createNode({ parentId: node.id, text: '', position: 'first' });
      showSaved();
      state.focusedNodeId = created.id;
      onTreeChanged?.();
    } else if (atEnd) {
      // Cursor at end, no children (or collapsed): create sibling immediately below
      await updateNode(node.id, { text: fullText }); // ensure saved
      const created = await createNode({ parentId: parent.id, text: '', afterId: node.id });
      showSaved();
      state.focusedNodeId = created.id;
      onTreeChanged?.();
    } else {
      // Cursor in middle: split node
      const textBefore = fullText.slice(0, cursorOffset);
      const textAfter = fullText.slice(cursorOffset);
      const result = await splitNode(node.id, textBefore, textAfter);
      showSaved();
      state.focusedNodeId = result.created.id;
      // Focus should be at start of the new node
      onTreeChanged?.();
    }
  } catch (err: any) {
    showSaveError('Failed: ' + err.message);
  }
}

/** Get the cursor offset as a plain-text character position within a contenteditable */
function getCursorOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return (el.textContent ?? '').length;

  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

export async function createSiblingAfter(nodeId: string) {
  if (!state.root) return;

  const parent = findParentOf(state.root, nodeId);
  if (!parent) return;

  try {
    const created = await createNode({ parentId: parent.id, text: '' });
    showSaved();
    state.focusedNodeId = created.id;
    onTreeChanged?.();
  } catch (err: any) {
    showSaveError('Create failed: ' + err.message);
  }
}

function findParentOf(root: TreeNode, childId: string): TreeNode | null {
  for (const child of root.children) {
    if (child.id === childId) return root;
    const found = findParentOf(child, childId);
    if (found) return found;
  }
  return null;
}

export async function deleteEmpty(nodeId: string) {
  if (!state.root) return;

  const all = flattenVisible(getDisplayRoot());
  const idx = all.findIndex(n => n.id === nodeId);
  const prevNode = idx > 0 ? all[idx - 1] : null;

  try {
    await deleteNode(nodeId);
    showSaved();
    state.focusedNodeId = prevNode?.id ?? null;
    onTreeChanged?.();
  } catch (err: any) {
    showSaveError('Delete failed: ' + err.message);
  }
}

export async function toggleComplete(nodeId: string) {
  if (!state.root) return;
  const node = findNode(state.root, nodeId);
  if (!node) return;

  const newStatus = node.status === 'active' ? 'completed' : 'active';
  try {
    await updateNode(nodeId, { status: newStatus });
    showSaved();
    onTreeChanged?.();
  } catch (err: any) {
    showSaveError('Update failed: ' + err.message);
  }
}

export async function indentNode(nodeId: string) {
  try {
    await moveNode(nodeId, { direction: 'indent' });
    showSaved();
    state.focusedNodeId = nodeId;
    onTreeChanged?.();
  } catch (err: any) {
    showSaveError(err.message);
  }
}

export async function outdentNode(nodeId: string) {
  try {
    await moveNode(nodeId, { direction: 'outdent' });
    showSaved();
    state.focusedNodeId = nodeId;
    onTreeChanged?.();
  } catch (err: any) {
    showSaveError(err.message);
  }
}

export async function moveNodeUp(nodeId: string) {
  try {
    await moveNode(nodeId, { direction: 'up' });
    showSaved();
    state.focusedNodeId = nodeId;
    onTreeChanged?.();
  } catch {
    // silently ignore if already at top
  }
}

export async function moveNodeDown(nodeId: string) {
  try {
    await moveNode(nodeId, { direction: 'down' });
    showSaved();
    state.focusedNodeId = nodeId;
    onTreeChanged?.();
  } catch {
    // silently ignore if already at bottom
  }
}

// ── Collapse/expand ──

export function toggleCollapse(nodeId: string) {
  const expanding = state.collapsedIds.has(nodeId);
  if (expanding) {
    state.collapsedIds.delete(nodeId);
  } else {
    state.collapsedIds.add(nodeId);
  }
  if (expanding) state.focusedNodeId = nodeId;
  persistCollapsedIds();
  renderTree();
}

export function collapseAll() {
  if (!state.root) return;
  const displayRoot = getDisplayRoot();
  function walk(n: TreeNode) {
    if (n.children.length > 0) state.collapsedIds.add(n.id);
    for (const c of n.children) walk(c);
  }
  for (const c of displayRoot.children) walk(c);
  persistCollapsedIds();
  renderTree();
}

export function expandAll() {
  state.collapsedIds.clear();
  persistCollapsedIds();
  renderTree();
}

// ── Focus navigation ──

function getDisplayRoot(): TreeNode {
  if (!state.root) throw new Error('No tree');
  if (state.zoomedNodeId) {
    return findNode(state.root, state.zoomedNodeId) ?? state.root;
  }
  return state.root;
}

function flattenVisible(node: TreeNode): TreeNode[] {
  const result: TreeNode[] = [];
  function walk(n: TreeNode) {
    if (!state.showCompleted && n.status === 'completed') return;
    result.push(n);
    if (!state.collapsedIds.has(n.id)) {
      for (const child of n.children) walk(child);
    }
  }
  for (const child of node.children) walk(child);
  return result;
}

export function focusFirstNode() {
  const all = flattenVisible(getDisplayRoot());
  if (all.length > 0 && state.focusedNodeId === all[0].id) {
    // Already at the top — zoom out one level
    if (state.zoomedNodeId && state.root) {
      const parent = findParentOf(state.root, state.zoomedNodeId);
      zoomTo(parent && parent.id !== state.root.id ? parent.id : null);
    }
    return;
  }
  if (all.length > 0) {
    state.focusedNodeId = all[0].id;
    focusCurrentNode();
  }
}

export function focusLastVisibleNode() {
  const all = flattenVisible(getDisplayRoot());
  if (all.length > 0) {
    state.focusedNodeId = all[all.length - 1].id;
    focusCurrentNode();
  }
}

export function focusPrevNode() {
  const all = flattenVisible(getDisplayRoot());
  const idx = all.findIndex(n => n.id === state.focusedNodeId);
  if (idx > 0) {
    state.focusedNodeId = all[idx - 1].id;
    focusCurrentNode();
  }
}

export function focusNextNode() {
  const all = flattenVisible(getDisplayRoot());
  const idx = all.findIndex(n => n.id === state.focusedNodeId);
  if (idx < all.length - 1) {
    state.focusedNodeId = all[idx + 1].id;
    focusCurrentNode();
  }
}

export function focusLastNode() {
  if (state.focusedNodeId) {
    focusCurrentNode();
  }
}

function focusCurrentNode() {
  if (!state.focusedNodeId) return;
  const textEl = document.querySelector(
    `.node[data-id="${CSS.escape(state.focusedNodeId)}"] > .node-self .node-text`
  ) as HTMLElement | null;
  if (textEl) {
    document.querySelectorAll('.node-self.focused').forEach(el => el.classList.remove('focused'));
    textEl.closest('.node-self')?.classList.add('focused');
    textEl.focus();
    textEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const range = document.createRange();
    const sel = window.getSelection();
    if (sel && textEl.childNodes.length > 0) {
      range.selectNodeContents(textEl);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}

// ── Context menu ──

function showContextMenu(node: TreeNode, x: number, y: number) {
  // Remove any existing menu
  document.getElementById('context-menu')?.remove();

  const menu = document.createElement('div');
  menu.id = 'context-menu';
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const items: { label: string; action: () => void }[] = [
    {
      label: node.status === 'active' ? 'Complete' : 'Reactivate',
      action: () => toggleComplete(node.id),
    },
    {
      label: node.description !== null ? 'Edit note' : 'Add note',
      action: () => promptNote(node),
    },
    {
      label: 'Delete',
      action: async () => {
        try {
          await deleteNode(node.id);
          showSaved();
          if (state.focusedNodeId === node.id) state.focusedNodeId = null;
          onTreeChanged?.();
        } catch (err: any) {
          showSaveError('Delete failed: ' + err.message);
        }
      },
    },
  ];

  // Add collapse/expand if has children
  if (node.children.length > 0) {
    const isCollapsed = state.collapsedIds.has(node.id);
    items.unshift({
      label: isCollapsed ? 'Expand' : 'Collapse',
      action: () => toggleCollapse(node.id),
    });
  }

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    if (item.label === 'Delete') el.classList.add('danger');
    el.textContent = item.label;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      item.action();
    });
    menu.appendChild(el);
  }

  document.body.appendChild(menu);

  // Adjust position if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${x - rect.width}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${y - rect.height}px`;
  }

  // Close on click outside
  const closeHandler = (e: MouseEvent) => {
    if (!menu.contains(e.target as HTMLElement)) {
      menu.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  // Delay so the current click doesn't immediately close it
  requestAnimationFrame(() => {
    document.addEventListener('click', closeHandler);
  });
}

async function promptNote(node: TreeNode) {
  const current = node.description ?? '';
  const note = prompt('Note:', current);
  if (note === null) return; // cancelled
  const value = note.trim() || null;
  try {
    await updateNode(node.id, { description: value });
    showSaved();
    onTreeChanged?.();
  } catch (err: any) {
    showSaveError('Update failed: ' + err.message);
  }
}
