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

/**
 * If a debounced text save is pending for this node, fire it now.
 * Call before any structural action so the server doesn't lag behind local state.
 */
function flushPendingSave(id: string) {
  const timer = debounceTimers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  debounceTimers.delete(id);
  if (!state.root) return;
  const node = findNode(state.root, id);
  if (!node) return;
  updateNode(id, { text: node.text })
    .then(() => showSaved())
    .catch((err) => showSaveError('Save failed: ' + err.message));
}

function getContainer(): HTMLElement {
  return document.getElementById('tree-container')!;
}

// ── Incremental DOM helpers ──
// These let structural ops patch the DOM in place instead of calling renderTree(),
// which rebuilds the entire visible subtree.

function findNodeEl(id: string): HTMLElement | null {
  return getContainer().querySelector(`.node[data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
}

function displayRootId(): string | null {
  return state.zoomedNodeId ?? state.root?.id ?? null;
}

/** Container element holding `parentId`'s children: either a `.node-children` div or `#tree-container`. */
function getParentContainerEl(parentId: string): HTMLElement | null {
  if (parentId === displayRootId()) return getContainer();
  const parentNodeEl = findNodeEl(parentId);
  if (!parentNodeEl) return null;
  return parentNodeEl.querySelector(':scope > .node-children') as HTMLElement | null;
}

function getOrCreateChildrenContainer(nodeEl: HTMLElement): HTMLElement {
  let children = nodeEl.querySelector(':scope > .node-children') as HTMLElement | null;
  if (!children) {
    children = document.createElement('div');
    children.className = 'node-children';
    nodeEl.appendChild(children);
  }
  return children;
}

function setHasChildren(nodeEl: HTMLElement, hasChildren: boolean) {
  nodeEl.classList.toggle('has-children', hasChildren);
  if (!hasChildren) nodeEl.classList.remove('collapsed');
  const collapseBtn = nodeEl.querySelector(':scope > .node-self > .node-collapse') as HTMLElement | null;
  if (collapseBtn) {
    collapseBtn.classList.toggle('visible', hasChildren);
    if (!hasChildren) collapseBtn.classList.remove('is-collapsed');
  }
}

/** Reorder `.node` elements under `containerEl` to match the visible order in `parentNode.children`. */
function syncChildrenDOM(parentNode: TreeNode, containerEl: HTMLElement) {
  const visible = parentNode.children.filter(c => state.showCompleted || c.status !== 'completed');
  let cursor: Element | null = containerEl.firstElementChild;
  // Skip non-.node siblings (like a leftover empty-placeholder) at the start.
  while (cursor && !cursor.classList.contains('node')) cursor = cursor.nextElementSibling;
  for (const child of visible) {
    const childEl = containerEl.querySelector(`:scope > .node[data-id="${CSS.escape(child.id)}"]`);
    if (!childEl) continue;
    if (childEl !== cursor) {
      containerEl.insertBefore(childEl, cursor);
    } else {
      cursor = childEl.nextElementSibling;
      while (cursor && !cursor.classList.contains('node')) cursor = cursor.nextElementSibling;
    }
  }
}

/** Remove a node's DOM element and clean up parent's has-children / empty-placeholder. */
function removeNodeFromDOM(nodeId: string): boolean {
  const nodeEl = findNodeEl(nodeId);
  if (!nodeEl) return false;
  const containerEl = nodeEl.parentElement as HTMLElement | null;
  nodeEl.remove();
  if (!containerEl) return true;
  if (containerEl.classList.contains('node-children') && containerEl.children.length === 0) {
    const parentNodeEl = containerEl.parentElement as HTMLElement;
    containerEl.remove();
    setHasChildren(parentNodeEl, false);
  } else if (containerEl === getContainer() && containerEl.children.length === 0) {
    const root = getDisplayRoot();
    containerEl.appendChild(renderEmptyPlaceholder(root.id));
  }
  return true;
}

/** Insert a freshly-rendered node element under its parent at the correct visible position. */
function insertNodeIntoDOM(parentNode: TreeNode, newNode: TreeNode): boolean {
  let containerEl = getParentContainerEl(parentNode.id);
  if (!containerEl) {
    // Parent has no children container yet — create one (only for non-root parents).
    if (parentNode.id === displayRootId()) return false;
    const parentNodeEl = findNodeEl(parentNode.id);
    if (!parentNodeEl) return false;
    containerEl = getOrCreateChildrenContainer(parentNodeEl);
    setHasChildren(parentNodeEl, true);
  }

  // If display root was empty, drop the placeholder before inserting.
  const placeholder = containerEl.querySelector(':scope > .empty-placeholder');
  placeholder?.remove();

  const visible = parentNode.children.filter(c => state.showCompleted || c.status !== 'completed');
  const idx = visible.findIndex(c => c.id === newNode.id);
  const nextId = idx === -1 ? null : visible[idx + 1]?.id;
  const nextEl = nextId
    ? containerEl.querySelector(`:scope > .node[data-id="${CSS.escape(nextId)}"]`)
    : null;

  containerEl.insertBefore(renderNode(newNode), nextEl);

  // Non-root parent now has at least one child — make sure has-children reflects that.
  if (parentNode.id !== displayRootId()) {
    const parentNodeEl = findNodeEl(parentNode.id);
    if (parentNodeEl) setHasChildren(parentNodeEl, true);
  }
  return true;
}

function focusNodeText(nodeId: string, caret?: 'start' | 'end') {
  const textEl = getContainer().querySelector(
    `.node[data-id="${CSS.escape(nodeId)}"] > .node-self .node-text`
  ) as HTMLElement | null;
  if (!textEl) return;
  document.querySelectorAll('.node-self.focused').forEach(el => el.classList.remove('focused'));
  textEl.closest('.node-self')?.classList.add('focused');
  textEl.focus();
  if (caret) setCaret(textEl, caret === 'start');
}

function setCaret(textEl: HTMLElement, atStart: boolean) {
  const sel = window.getSelection();
  if (!sel || textEl.childNodes.length === 0) return;
  const range = document.createRange();
  range.selectNodeContents(textEl);
  range.collapse(atStart);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Build a `.node-children` container for a node's visible children, or null if there are none. */
function renderChildren(node: TreeNode): HTMLElement | null {
  const visible = node.children.filter(c => state.showCompleted || c.status !== 'completed');
  if (visible.length === 0) return null;
  const childrenEl = document.createElement('div');
  childrenEl.className = 'node-children';
  for (const child of visible) {
    childrenEl.appendChild(renderNode(child));
  }
  return childrenEl;
}

/**
 * Move an existing `.node` element under `parentNode` at its current model position.
 * Returns false if the DOM is missing pieces — caller should fall back to renderTree().
 */
export function moveNodeElInDOM(parentNode: TreeNode, nodeId: string): boolean {
  const nodeEl = findNodeEl(nodeId);
  if (!nodeEl) return false;
  let containerEl = getParentContainerEl(parentNode.id);
  if (!containerEl) {
    if (parentNode.id === displayRootId()) return false;
    const parentNodeEl = findNodeEl(parentNode.id);
    if (!parentNodeEl) return false;
    containerEl = getOrCreateChildrenContainer(parentNodeEl);
  }
  const oldContainerEl = nodeEl.parentElement as HTMLElement | null;

  const visible = parentNode.children.filter(c => state.showCompleted || c.status !== 'completed');
  const idx = visible.findIndex(c => c.id === nodeId);
  if (idx === -1) return false;
  const nextId = visible[idx + 1]?.id;
  const nextEl = nextId
    ? containerEl.querySelector(`:scope > .node[data-id="${CSS.escape(nextId)}"]`)
    : null;
  containerEl.insertBefore(nodeEl, nextEl);

  if (parentNode.id !== displayRootId()) {
    const parentNodeEl = findNodeEl(parentNode.id);
    if (parentNodeEl) setHasChildren(parentNodeEl, true);
  }
  if (oldContainerEl && oldContainerEl !== containerEl &&
      oldContainerEl.classList.contains('node-children') && oldContainerEl.children.length === 0) {
    const oldParentNodeEl = oldContainerEl.parentElement as HTMLElement;
    oldContainerEl.remove();
    setHasChildren(oldParentNodeEl, false);
  }
  return true;
}

let renderGeneration = 0;
/** Nodes appended per animation frame while a large tree streams in. */
const RENDER_BUDGET = 400;

interface RenderQueueItem {
  node: TreeNode;
  containerEl: HTMLElement;
}

export function renderTree() {
  const generation = ++renderGeneration;
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

  initDragDrop(container, () => onTreeChanged?.());

  if (visibleChildren.length === 0) {
    container.appendChild(renderEmptyPlaceholder(displayRoot.id));
    restoreFocus(container, true);
    return;
  }

  // Stream the tree in depth-first chunks: the first chunk paints the top of the
  // document synchronously, the rest fills in one budget-sized batch per frame.
  // A newer renderTree() call bumps the generation and abandons this stream.
  const queue: RenderQueueItem[] = [];
  for (let i = visibleChildren.length - 1; i >= 0; i--) {
    queue.push({ node: visibleChildren[i], containerEl: container });
  }

  let focusRestored = false;
  const pump = () => {
    if (generation !== renderGeneration) return;
    for (let budget = RENDER_BUDGET; budget > 0 && queue.length > 0; budget--) {
      const item = queue.pop()!;
      item.containerEl.appendChild(renderNode(item.node, queue));
    }
    const done = queue.length === 0;
    if (!focusRestored) focusRestored = restoreFocus(container, done);
    if (!done) requestAnimationFrame(pump);
  };
  pump();
}

/**
 * Restore focus to state.focusedNodeId after a full render, falling back to the
 * first visible node if the target isn't in the visible hierarchy. While a
 * streamed render is still in flight (`final` false), a missing element just
 * means the node hasn't been appended yet — returns false so the pump retries.
 */
function restoreFocus(container: HTMLElement, final: boolean): boolean {
  if (!state.focusedNodeId) {
    state.pendingCursorAt = null;
    return true;
  }
  // The user focused a node while the stream was filling in — don't steal it.
  if (document.activeElement?.classList.contains('node-text')) {
    state.pendingCursorAt = null;
    return true;
  }
  let textEl = container.querySelector(
    `.node[data-id="${CSS.escape(state.focusedNodeId)}"] > .node-self .node-text`
  ) as HTMLElement | null;
  if (!textEl) {
    if (!final) return false;
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
    textEl.scrollIntoView({ block: 'nearest' });
    // Consume the one-shot cursor hint; default to end for back-compat.
    setCaret(textEl, state.pendingCursorAt === 'start');
  }
  state.pendingCursorAt = null;
  return true;
}

function renderNode(node: TreeNode, queue?: RenderQueueItem[]): HTMLElement {
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
  }
  // Always attach: a leaf can become a parent via incremental ops (indent/drag),
  // which only toggle the `visible` class — they can't add listeners after the fact.
  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!collapseBtn.classList.contains('visible')) return;
    toggleCollapse(node.id);
  });
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
      flushPendingSave(node.id);
      handleEnter(node, textEl);
    }
  });

  // Sync text immediately so structural ops see the latest value; debounce only the network save.
  textEl.addEventListener('input', () => {
    const id = node.id;
    node.text = textEl.textContent ?? '';
    if (debounceTimers.has(id)) clearTimeout(debounceTimers.get(id)!);
    debounceTimers.set(id, setTimeout(() => {
      debounceTimers.delete(id);
      updateNode(id, { text: node.text })
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

  // Children (not rendered when collapsed)
  if (hasVisibleChildren && !isCollapsed) {
    if (queue) {
      // Streamed render: attach an empty container and let the pump fill it in.
      const childrenEl = document.createElement('div');
      childrenEl.className = 'node-children';
      el.appendChild(childrenEl);
      const visible = node.children.filter(c => state.showCompleted || c.status !== 'completed');
      for (let i = visible.length - 1; i >= 0; i--) {
        queue.push({ node: visible[i], containerEl: childrenEl });
      }
    } else {
      const childrenEl = renderChildren(node);
      if (childrenEl) el.appendChild(childrenEl);
    }
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

  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = textEl.textContent?.trim() ?? '';
      if (!text) return;
      if (!state.root) return;
      const parent = findNode(state.root, parentId);
      if (!parent) return;

      const newNode = makeNode(text);
      parent.children.push(newNode);
      state.focusedNodeId = newNode.id;

      if (insertNodeIntoDOM(parent, newNode)) {
        focusNodeText(newNode.id);
      } else {
        renderTree();
      }

      createNode({ id: newNode.id, parentId, text })
        .then(() => showSaved())
        .catch((err) => {
          removeNode(newNode.id);
          onTreeChanged?.();
          showSaveError('Create failed: ' + err.message);
        });
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

    if (insertNodeIntoDOM(parent, newNode)) {
      focusNodeText(node.id);
    } else {
      renderTree();
    }

    createNode({ id: newNode.id, parentId: parent.id, text: '', beforeId: node.id })
      .then(() => showSaved())
      .catch((err) => {
        removeNode(newNode.id);
        onTreeChanged?.();
        showSaveError('Failed: ' + err.message);
      });
  } else if (atEnd && hasChildren && !state.collapsedIds.has(node.id)) {
    // Cursor at end, node has visible children: create empty first child
    const newNode = makeNode('');
    node.children.unshift(newNode);
    state.focusedNodeId = newNode.id;

    if (insertNodeIntoDOM(node, newNode)) {
      focusNodeText(newNode.id);
    } else {
      renderTree();
    }

    // Text was synced on input + flushed before handleEnter, so updateNode is redundant.
    createNode({ id: newNode.id, parentId: node.id, text: '', position: 'first' })
      .then(() => showSaved())
      .catch((err) => {
        removeNode(newNode.id);
        onTreeChanged?.();
        showSaveError('Failed: ' + err.message);
      });
  } else if (atEnd) {
    // Cursor at end, no children (or collapsed): create sibling immediately below
    const newNode = makeNode('');
    const idx = parent.children.findIndex(c => c.id === node.id);
    parent.children.splice(idx + 1, 0, newNode);
    state.focusedNodeId = newNode.id;

    if (insertNodeIntoDOM(parent, newNode)) {
      focusNodeText(newNode.id);
    } else {
      renderTree();
    }

    createNode({ id: newNode.id, parentId: parent.id, text: '', afterId: node.id })
      .then(() => showSaved())
      .catch((err) => {
        removeNode(newNode.id);
        onTreeChanged?.();
        showSaveError('Failed: ' + err.message);
      });
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

    // Incremental DOM: trim the original, drop its children container, insert the new node
    // (renderNode re-renders the stolen children under it).
    const nodeEl = findNodeEl(node.id);
    if (nodeEl) {
      textEl.textContent = textBefore;
      nodeEl.querySelector(':scope > .node-children')?.remove();
      setHasChildren(nodeEl, false);
    }
    if (nodeEl && insertNodeIntoDOM(parent, newNode)) {
      focusNodeText(newNode.id, 'start');
    } else {
      state.pendingCursorAt = 'start';
      renderTree();
    }

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


export function createSiblingAfter(nodeId: string) {
  if (!state.root) return;

  const parent = findParentOf(state.root, nodeId);
  if (!parent) return;

  const newNode = makeNode('');
  const idx = parent.children.findIndex(c => c.id === nodeId);
  parent.children.splice(idx === -1 ? parent.children.length : idx + 1, 0, newNode);
  state.focusedNodeId = newNode.id;

  if (insertNodeIntoDOM(parent, newNode)) {
    focusNodeText(newNode.id);
  } else {
    renderTree();
  }

  createNode({ id: newNode.id, parentId: parent.id, text: '', afterId: nodeId })
    .then(() => showSaved())
    .catch((err) => {
      removeNode(newNode.id);
      onTreeChanged?.();
      showSaveError('Create failed: ' + err.message);
    });
}

export function deleteEmpty(nodeId: string) {
  if (!state.root) return;
  flushPendingSave(nodeId);

  const all = flattenVisible(getDisplayRoot());
  const idx = all.findIndex(n => n.id === nodeId);
  const prevNode = idx > 0 ? all[idx - 1] : null;

  removeNode(nodeId);
  state.focusedNodeId = prevNode?.id ?? null;

  if (!removeNodeFromDOM(nodeId)) {
    renderTree();
  } else if (state.focusedNodeId) {
    focusNodeText(state.focusedNodeId);
  }

  deleteNode(nodeId)
    .then(() => showSaved())
    .catch((err) => {
      showSaveError('Delete failed: ' + err.message);
      onTreeChanged?.();
    });
}

export function toggleComplete(nodeId: string) {
  if (!state.root) return;
  flushPendingSave(nodeId);
  const node = findNode(state.root, nodeId);
  if (!node) return;

  const newStatus = node.status === 'active' ? 'completed' : 'active';
  node.status = newStatus;

  if (newStatus === 'completed' && !state.showCompleted) {
    // Node disappears from view — remove it and let removeNodeFromDOM clean up.
    if (!removeNodeFromDOM(nodeId)) renderTree();
  } else {
    const nodeEl = findNodeEl(nodeId);
    if (nodeEl) {
      nodeEl.dataset.status = newStatus;
      nodeEl.classList.toggle('completed', newStatus === 'completed');
    } else {
      renderTree();
    }
  }

  updateNode(nodeId, { status: newStatus })
    .then(() => showSaved())
    .catch((err) => {
      showSaveError('Update failed: ' + err.message);
      onTreeChanged?.();
    });
}

export function indentNode(nodeId: string) {
  if (!state.root) return;
  flushPendingSave(nodeId);
  const parent = findParentOf(state.root, nodeId);
  if (!parent) return;
  const idx = parent.children.findIndex(c => c.id === nodeId);
  if (idx <= 0) return; // no previous sibling — server would reject
  const node = parent.children[idx];
  const newParent = parent.children[idx - 1];

  parent.children.splice(idx, 1);
  newParent.children.push(node);
  // Auto-expand the new parent so the indented node remains visible.
  if (state.collapsedIds.has(newParent.id)) {
    state.collapsedIds.delete(newParent.id);
    persistCollapsedIds();
  }
  state.focusedNodeId = nodeId;

  // Incremental DOM: move .node into the new parent's children container.
  const nodeEl = findNodeEl(nodeId);
  const newParentEl = findNodeEl(newParent.id);
  if (nodeEl && newParentEl) {
    const oldContainerEl = nodeEl.parentElement as HTMLElement | null;
    const newContainerEl = getOrCreateChildrenContainer(newParentEl);
    newContainerEl.appendChild(nodeEl);
    setHasChildren(newParentEl, true);
    if (oldContainerEl?.classList.contains('node-children') && oldContainerEl.children.length === 0) {
      const oldParentNodeEl = oldContainerEl.parentElement as HTMLElement;
      oldContainerEl.remove();
      setHasChildren(oldParentNodeEl, false);
    }
    focusNodeText(nodeId);
  } else {
    renderTree();
  }

  moveNode(nodeId, { direction: 'indent' })
    .then(() => showSaved())
    .catch((err) => {
      showSaveError(err.message);
      onTreeChanged?.();
    });
}

export function outdentNode(nodeId: string) {
  if (!state.root) return;
  flushPendingSave(nodeId);
  const parent = findParentOf(state.root, nodeId);
  if (!parent) return;
  const grandparent = findParentOf(state.root, parent.id);
  if (!grandparent) return; // parent is root — server would reject
  const idx = parent.children.findIndex(c => c.id === nodeId);
  const parentIdx = grandparent.children.findIndex(c => c.id === parent.id);
  if (idx === -1 || parentIdx === -1) return;
  const node = parent.children[idx];

  parent.children.splice(idx, 1);
  grandparent.children.splice(parentIdx + 1, 0, node);
  state.focusedNodeId = nodeId;

  // Incremental DOM: move .node to grandparent container, after the parent's .node.
  const nodeEl = findNodeEl(nodeId);
  const parentEl = findNodeEl(parent.id);
  const grandContainerEl = getParentContainerEl(grandparent.id);
  if (nodeEl && parentEl && grandContainerEl) {
    const oldContainerEl = nodeEl.parentElement as HTMLElement | null;
    grandContainerEl.insertBefore(nodeEl, parentEl.nextSibling);
    if (oldContainerEl?.classList.contains('node-children') && oldContainerEl.children.length === 0) {
      oldContainerEl.remove();
      setHasChildren(parentEl, false);
    }
    focusNodeText(nodeId);
  } else {
    renderTree();
  }

  moveNode(nodeId, { direction: 'outdent' })
    .then(() => showSaved())
    .catch((err) => {
      showSaveError(err.message);
      onTreeChanged?.();
    });
}

export function moveNodeUp(nodeId: string) {
  if (!state.root) return;
  flushPendingSave(nodeId);
  const parent = findParentOf(state.root, nodeId);
  if (!parent) return;
  const idx = parent.children.findIndex(c => c.id === nodeId);
  if (idx <= 0) return; // already at top
  [parent.children[idx - 1], parent.children[idx]] = [parent.children[idx], parent.children[idx - 1]];
  state.focusedNodeId = nodeId;

  const containerEl = getParentContainerEl(parent.id);
  if (containerEl) {
    syncChildrenDOM(parent, containerEl);
    focusNodeText(nodeId);
  } else {
    renderTree();
  }

  moveNode(nodeId, { direction: 'up' })
    .then(() => showSaved())
    .catch(() => onTreeChanged?.());
}

export function moveNodeDown(nodeId: string) {
  if (!state.root) return;
  flushPendingSave(nodeId);
  const parent = findParentOf(state.root, nodeId);
  if (!parent) return;
  const idx = parent.children.findIndex(c => c.id === nodeId);
  if (idx === -1 || idx >= parent.children.length - 1) return; // already at bottom
  [parent.children[idx], parent.children[idx + 1]] = [parent.children[idx + 1], parent.children[idx]];
  state.focusedNodeId = nodeId;

  const containerEl = getParentContainerEl(parent.id);
  if (containerEl) {
    syncChildrenDOM(parent, containerEl);
    focusNodeText(nodeId);
  } else {
    renderTree();
  }

  moveNode(nodeId, { direction: 'down' })
    .then(() => showSaved())
    .catch(() => onTreeChanged?.());
}

// ── Collapse/expand ──

export function toggleCollapse(nodeId: string) {
  const expanding = state.collapsedIds.has(nodeId);
  if (expanding) {
    state.collapsedIds.delete(nodeId);
  } else {
    state.collapsedIds.add(nodeId);
  }
  persistCollapsedIds();

  const node = state.root ? findNode(state.root, nodeId) : null;
  const nodeEl = findNodeEl(nodeId);
  if (!node || !nodeEl) {
    if (expanding) state.focusedNodeId = nodeId;
    renderTree();
    return;
  }

  const hasVisibleChildren = node.children.some(
    c => state.showCompleted || c.status !== 'completed'
  );
  if (!hasVisibleChildren) return; // nothing to show or hide

  // Only steal focus (and pop the mobile keyboard) if the user was already editing a node.
  const wasEditing = document.activeElement?.classList.contains('node-text') ?? false;

  const collapseBtn = nodeEl.querySelector(':scope > .node-self > .node-collapse');
  nodeEl.querySelector(':scope > .node-children')?.remove();

  if (expanding) {
    nodeEl.classList.remove('collapsed');
    collapseBtn?.classList.remove('is-collapsed');
    const childrenEl = renderChildren(node);
    if (childrenEl) nodeEl.appendChild(childrenEl);
    if (wasEditing) {
      state.focusedNodeId = nodeId;
      focusNodeText(nodeId);
    }
  } else {
    nodeEl.classList.add('collapsed');
    collapseBtn?.classList.add('is-collapsed');
    // If focus lived inside the collapsed subtree, it just left the DOM — move it to the collapsed node.
    if (state.focusedNodeId && state.focusedNodeId !== nodeId && findNode(node, state.focusedNodeId)) {
      state.focusedNodeId = nodeId;
      if (wasEditing) focusNodeText(nodeId);
    }
  }
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
    textEl.scrollIntoView({ block: 'nearest' });
    setCaret(textEl, atStart);
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
      action: () => {
        if (!state.root) return;
        const all = flattenVisible(getDisplayRoot());
        const idx = all.findIndex(n => n.id === node.id);
        const prevNode = idx > 0 ? all[idx - 1] : null;

        removeNode(node.id);
        if (state.focusedNodeId === node.id) {
          state.focusedNodeId = prevNode?.id ?? null;
        }

        if (!removeNodeFromDOM(node.id)) {
          renderTree();
        } else if (state.focusedNodeId) {
          focusNodeText(state.focusedNodeId);
        }

        deleteNode(node.id)
          .then(() => showSaved())
          .catch((err) => {
            showSaveError('Delete failed: ' + err.message);
            onTreeChanged?.();
          });
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
