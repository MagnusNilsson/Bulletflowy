import { state } from './state.js';
import { focusActionBar } from './action-bar.js';
import {
  createSiblingAfter,
  deleteEmpty,
  toggleComplete,
  indentNode,
  outdentNode,
  moveNodeUp,
  moveNodeDown,
  focusPrevNode,
  focusNextNode,
  focusFirstNode,
  focusLastVisibleNode,
  focusLastNode,
  toggleCollapse,
  collapseAll,
  expandAll,
} from './tree-renderer.js';

export function initKeyboard() {
  document.addEventListener('keydown', handleKeyDown);
}

function handleKeyDown(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  const isNodeText = target.classList.contains('node-text');
  const nodeEl = target.closest('.node') as HTMLElement | null;
  const nodeId = nodeEl?.dataset.id;
  const actionBarInput = document.getElementById('search-input') as HTMLInputElement;

  // Ctrl/Cmd+K: focus action bar from anywhere
  if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    focusActionBar();
    return;
  }

  // Escape: close action bar and return to last node, or blur node
  if (e.key === 'Escape') {
    if (target === actionBarInput) {
      actionBarInput.value = '';
      actionBarInput.blur();
      actionBarInput.dispatchEvent(new Event('input'));
      focusLastNode();
    } else if (isNodeText) {
      target.blur();
      state.focusedNodeId = null;
      document.querySelectorAll('.node-self.focused').forEach(el => el.classList.remove('focused'));
    }
    return;
  }

  if (!isNodeText || !nodeId) return;

  // Cmd/Ctrl + ArrowUp: go to first node
  if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey) && !e.altKey) {
    e.preventDefault();
    focusFirstNode();
    return;
  }

  // Cmd/Ctrl + ArrowDown: go to last node
  if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey) && !e.altKey) {
    e.preventDefault();
    focusLastVisibleNode();
    return;
  }

  // Ctrl/Cmd + Enter: toggle complete
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    toggleComplete(nodeId);
    return;
  }

  // Tab: indent
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    indentNode(nodeId);
    return;
  }

  // Shift+Tab: outdent
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    outdentNode(nodeId);
    return;
  }

  // Cmd/Ctrl + .: toggle collapse current node
  if (e.key === '.' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    e.preventDefault();
    toggleCollapse(nodeId);
    return;
  }

  // Cmd/Ctrl + Shift + .: collapse all
  if (e.key === '.' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault();
    collapseAll();
    return;
  }

  // Cmd/Ctrl + Shift + ,: expand all
  if (e.key === ',' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault();
    expandAll();
    return;
  }

  // Arrow up/down: move focus
  if (e.key === 'ArrowUp' && !e.altKey) {
    e.preventDefault();
    focusPrevNode();
    return;
  }

  if (e.key === 'ArrowDown' && !e.altKey) {
    e.preventDefault();
    focusNextNode();
    return;
  }

  // Alt + Arrow: move node
  if (e.key === 'ArrowUp' && e.altKey) {
    e.preventDefault();
    moveNodeUp(nodeId);
    return;
  }

  if (e.key === 'ArrowDown' && e.altKey) {
    e.preventDefault();
    moveNodeDown(nodeId);
    return;
  }

  // Backspace on empty: delete
  if (e.key === 'Backspace' && (target.textContent ?? '') === '') {
    e.preventDefault();
    deleteEmpty(nodeId);
    return;
  }
}
