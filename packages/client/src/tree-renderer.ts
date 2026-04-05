import type { TreeNode } from '@bulletflowy/shared';
import { v7 as uuidv7 } from 'uuid';
import { state, findNode, findParentOf, getBreadcrumbs, persistCollapsedIds } from './state.js';
import { updateNode, createNode, deleteNode, moveNode, splitNode } from './api.js';
import { showSaved, showSaveError } from './save-indicator.js';
import { getCursorOffset } from './cursor.js';
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

  initDragDrop(container, () => onTreeChanged?.());

  // Restore focus — fall back to first visible node if target is outside visible hierarchy
  if (state.focusedNodeId) {
    let textEl = container.querySelector(
      `.node[data-id="${CSS.escape(state.focusedNodeId)}"] > .node-self .node-text`
    ) as HTMLElement | null;
    if (!textEl) {
      // Focused node not visible — recover to first visible node
      const firstNode = container.querySelector('.node > .node-self .node-text') as HTMLElement | null;
      if (firstNode) {
        const firstNodeEl = firstNode.closest('.node') as HTMLElement | null;
        if (firstNodeEl?.dataset.id) state.focusedNodeId = firstNodeEl.dataset.id;
        textEl = firstNode;
      }
    }
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
    makeDescriptionEditable(descEl, node);
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

function makeNode(text: string): TreeNode {
  return {
    id: uuidv7(),
    text,
    description: null,
    status: 'active',
    children: [],
  };
}

function removeNode(nodeId: string) {
  if (!state.root) return;
  const parent = findParentOf(state.root, nodeId);
  if (parent) {
    parent.children = parent.children.filter(c => c.id !== nodeId);
  }
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

  if (atStart && fullText.length > 0) {
    // Cursor at start: create empty sibling ABOVE
    const newNode = makeNode('');
    const idx = parent.children.findIndex(c => c.id === node.id);
    parent.children.splice(idx, 0, newNode);
    state.focusedNodeId = node.id;
    renderTree();

    try {
      await createNode({ id: newNode.id, parentId: parent.id, text: '', beforeId: node.id });
      showSaved();
    } catch (err: any) {
      removeNode(newNode.id);
      onTreeChanged?.();
      showSaveError('Failed: ' + err.message);
    }
  } else if (atEnd && hasChildren && !state.collapsedIds.has(node.id)) {
    // Cursor at end, node has visible children: create empty first child
    const newNode = makeNode('');
    node.children.unshift(newNode);
    state.focusedNodeId = newNode.id;
    renderTree();

    try {
      await updateNode(node.id, { text: fullText });
      await createNode({ id: newNode.id, parentId: node.id, text: '', position: 'first' });
      showSaved();
    } catch (err: any) {
      removeNode(newNode.id);
      onTreeChanged?.();
      showSaveError('Failed: ' + err.message);
    }
  } else if (atEnd) {
    // Cursor at end, no children (or collapsed): create sibling immediately below
    const newNode = makeNode('');
    const idx = parent.children.findIndex(c => c.id === node.id);
    parent.children.splice(idx + 1, 0, newNode);
    state.focusedNodeId = newNode.id;
    renderTree();

    try {
      await updateNode(node.id, { text: fullText });
      await createNode({ id: newNode.id, parentId: parent.id, text: '', afterId: node.id });
      showSaved();
    } catch (err: any) {
      removeNode(newNode.id);
      onTreeChanged?.();
      showSaveError('Failed: ' + err.message);
    }
  } else {
    // Cursor in middle: split node
    const textBefore = fullText.slice(0, cursorOffset);
    const textAfter = fullText.slice(cursorOffset);

    // Optimistic: update current node text, create sibling with the rest + steal children
    node.text = textBefore;
    const newNode = makeNode(textAfter);
    newNode.children = node.children;
    node.children = [];
    const idx = parent.children.findIndex(c => c.id === node.id);
    parent.children.splice(idx + 1, 0, newNode);
    state.focusedNodeId = newNode.id;
    renderTree();

    try {
      await splitNode(node.id, textBefore, textAfter, newNode.id);
      showSaved();
    } catch (err: any) {
      // Revert: merge back
      node.text = fullText;
      node.children = newNode.children;
      removeNode(newNode.id);
      state.focusedNodeId = node.id;
      onTreeChanged?.();
      showSaveError('Failed: ' + err.message);
    }
  }
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

export function focusPrevNode(cursorHint?: 'start' | 'end' | 'middle') {
  const all = flattenVisible(getDisplayRoot());
  const idx = all.findIndex(n => n.id === state.focusedNodeId);
  if (idx > 0) {
    state.focusedNodeId = all[idx - 1].id;
    const atStart = cursorHint === 'start' || cursorHint === 'middle';
    focusCurrentNode(atStart);
  }
}

export function focusNextNode(cursorHint?: 'start' | 'end' | 'middle') {
  const all = flattenVisible(getDisplayRoot());
  const idx = all.findIndex(n => n.id === state.focusedNodeId);
  if (idx < all.length - 1) {
    state.focusedNodeId = all[idx + 1].id;
    const atStart = cursorHint === 'start' || cursorHint === 'middle';
    focusCurrentNode(atStart);
  }
}

export function refocusCurrentNode() {
  if (state.focusedNodeId) {
    focusCurrentNode();
  }
}

function focusCurrentNode(atStart: boolean = false) {
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
      range.collapse(atStart);
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
    ...(node.description === null ? [{
      label: 'Add note',
      action: () => startInlineNote(node),
    }] : []),
    {
      label: 'Export',
      action: () => showExportModal(node),
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

// ── Export helpers ──

function nodeToPlainText(node: TreeNode, depth: number): string {
  const indent = '  '.repeat(depth);
  let txt = `${indent}- ${node.text}\n`;
  if (node.description) {
    const noteIndent = '  '.repeat(depth) + '  ';
    for (const line of node.description.split('\n')) {
      txt += `${noteIndent}${line}\n`;
    }
  }
  for (const child of node.children) {
    txt += nodeToPlainText(child, depth + 1);
  }
  return txt;
}

function nodeToHtml(node: TreeNode): string {
  let html = `<li>${escapeHtml(node.text)}`;
  if (node.children.length > 0) {
    html += '<ul>';
    for (const child of node.children) {
      html += nodeToHtml(child);
    }
    html += '</ul>';
  }
  html += '</li>';
  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showExportModal(node: TreeNode) {
  document.getElementById('export-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'export-modal';
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const title = document.createElement('h2');
  title.textContent = 'Export';
  modal.appendChild(title);

  const styledBtn = document.createElement('button');
  styledBtn.className = 'export-btn';
  styledBtn.textContent = 'Styled bullet list';
  styledBtn.addEventListener('click', async () => {
    const html = '<ul>' + nodeToHtml(node) + '</ul>';
    const plain = nodeToPlainText(node, 0);
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    styledBtn.textContent = 'Copied!';
    setTimeout(() => overlay.remove(), 600);
  });
  modal.appendChild(styledBtn);

  const plainBtn = document.createElement('button');
  plainBtn.className = 'export-btn';
  plainBtn.textContent = 'Plain text';
  plainBtn.addEventListener('click', async () => {
    const plain = nodeToPlainText(node, 0);
    await navigator.clipboard.writeText(plain);
    plainBtn.textContent = 'Copied!';
    setTimeout(() => overlay.remove(), 600);
  });
  modal.appendChild(plainBtn);

  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', handler);
    }
  });

  document.body.appendChild(overlay);
}

function startInlineNote(node: TreeNode) {
  const nodeEl = document.querySelector(`.node[data-id="${node.id}"]`);
  if (!nodeEl) return;

  // Create or find existing description element
  let descEl = nodeEl.querySelector('.node-description') as HTMLElement | null;
  if (!descEl) {
    descEl = document.createElement('div');
    descEl.className = 'node-description';
    // Insert before children container or at end
    const childrenEl = nodeEl.querySelector('.node-children');
    if (childrenEl) {
      nodeEl.insertBefore(descEl, childrenEl);
    } else {
      nodeEl.appendChild(descEl);
    }
  }

  makeDescriptionEditable(descEl, node);
  descEl.focus();
}

function makeDescriptionEditable(descEl: HTMLElement, node: TreeNode) {
  descEl.contentEditable = 'true';
  descEl.dataset.placeholder = 'Add a note...';

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const saveNote = () => {
    const value = (descEl.textContent ?? '').trim() || null;
    node.description = value;
    updateNode(node.id, { description: value })
      .then(() => showSaved())
      .catch((err) => showSaveError('Save failed: ' + err.message));
  };

  descEl.addEventListener('input', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNote, 300);
  });

  descEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      descEl.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      descEl.blur();
    }
  });

  descEl.addEventListener('blur', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveNote();
    }
    const value = (descEl.textContent ?? '').trim();
    if (!value) {
      descEl.remove();
      node.description = null;
    }
  });
}
