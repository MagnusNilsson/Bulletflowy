import type { TreeNode } from '@bulletflowy/shared';

export interface AppState {
  root: TreeNode | null;
  zoomedNodeId: string | null;
  focusedNodeId: string | null;
  /** Cursor placement hint consumed by the next renderTree focus restore */
  pendingCursorAt: 'start' | 'end' | null;
  showCompleted: boolean;
  collapsedIds: Set<string>;
}

const COLLAPSED_KEY = 'bulletflowy-collapsed';

function loadCollapsedIds(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set();
}

export function persistCollapsedIds() {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...state.collapsedIds]));
}

export const state: AppState = {
  root: null,
  zoomedNodeId: null,
  focusedNodeId: null,
  pendingCursorAt: null,
  showCompleted: false,
  collapsedIds: loadCollapsedIds(),
};

/** Find a node by id in the tree */
export function findNode(node: TreeNode, id: string): TreeNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** Find the parent of a node by child ID */
export function findParentOf(root: TreeNode, childId: string): TreeNode | null {
  for (const child of root.children) {
    if (child.id === childId) return root;
    const found = findParentOf(child, childId);
    if (found) return found;
  }
  return null;
}

/** Get breadcrumb path from root to node */
export function getBreadcrumbs(root: TreeNode, targetId: string): TreeNode[] {
  const path: TreeNode[] = [];

  function walk(node: TreeNode): boolean {
    path.push(node);
    if (node.id === targetId) return true;
    for (const child of node.children) {
      if (walk(child)) return true;
    }
    path.pop();
    return false;
  }

  walk(root);
  return path;
}
