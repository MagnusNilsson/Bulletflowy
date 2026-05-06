import type Database from 'better-sqlite3';
import type { TreeNode, TreeResponse } from '@bulletflowy/shared';

interface DbRow {
  id: string;
  parent_id: string | null;
  user_id: string;
  position: string;
  text: string;
  description: string | null;
  status: 'active' | 'completed';
  created_at: string;
  updated_at: string;
}

export function getTree(db: Database.Database, userId: string, includeCompleted: boolean): TreeResponse {
  const rows = includeCompleted
    ? db.prepare('SELECT * FROM nodes WHERE user_id = ? ORDER BY position').all(userId) as DbRow[]
    : db.prepare(`
        WITH RECURSIVE tree AS (
          SELECT * FROM nodes WHERE user_id = ? AND parent_id IS NULL
          UNION ALL
          SELECT n.* FROM nodes n INNER JOIN tree t ON n.parent_id = t.id
            WHERE n.user_id = ? AND n.status = 'active'
        ) SELECT * FROM tree ORDER BY position
      `).all(userId, userId) as DbRow[];

  // Build lookup maps
  const nodeMap = new Map<string, TreeNode>();
  const childrenMap = new Map<string | null, TreeNode[]>();

  for (const row of rows) {
    const treeNode: TreeNode = {
      id: row.id,
      text: row.text,
      description: row.description,
      status: row.status,
      children: [],
    };
    nodeMap.set(row.id, treeNode);

    const siblings = childrenMap.get(row.parent_id) ?? [];
    siblings.push(treeNode);
    childrenMap.set(row.parent_id, siblings);
  }

  // Wire up children
  for (const [parentId, children] of childrenMap) {
    if (parentId !== null) {
      const parent = nodeMap.get(parentId);
      if (parent) {
        parent.children = children;
      }
    }
  }

  const roots = childrenMap.get(null) ?? [];
  if (roots.length === 0) {
    throw new Error('Root node not found');
  }

  return { root: roots[0] };
}

export function getSubtree(db: Database.Database, userId: string, nodeId: string, includeCompleted: boolean): TreeResponse {
  const nodeRow = db.prepare('SELECT * FROM nodes WHERE id = ? AND user_id = ?').get(nodeId, userId) as DbRow | undefined;
  if (!nodeRow) {
    throw new NotFoundError(`Node ${nodeId} not found`);
  }

  const query = includeCompleted
    ? `WITH RECURSIVE descendants AS (
        SELECT * FROM nodes WHERE id = ? AND user_id = ?
        UNION ALL
        SELECT n.* FROM nodes n INNER JOIN descendants d ON n.parent_id = d.id WHERE n.user_id = ?
      ) SELECT * FROM descendants ORDER BY position`
    : `WITH RECURSIVE descendants AS (
        SELECT * FROM nodes WHERE id = ? AND user_id = ?
        UNION ALL
        SELECT n.* FROM nodes n INNER JOIN descendants d ON n.parent_id = d.id WHERE n.user_id = ? AND n.status = 'active'
      ) SELECT * FROM descendants ORDER BY position`;

  const rows = db.prepare(query).all(nodeId, userId, userId) as DbRow[];

  const nodeMap = new Map<string, TreeNode>();
  const childrenMap = new Map<string | null, TreeNode[]>();

  for (const row of rows) {
    const treeNode: TreeNode = {
      id: row.id,
      text: row.text,
      description: row.description,
      status: row.status,
      children: [],
    };
    nodeMap.set(row.id, treeNode);

    const siblings = childrenMap.get(row.parent_id) ?? [];
    siblings.push(treeNode);
    childrenMap.set(row.parent_id, siblings);
  }

  for (const [parentId, children] of childrenMap) {
    if (parentId !== null) {
      const parent = nodeMap.get(parentId);
      if (parent) {
        parent.children = children;
      }
    }
  }

  const root = nodeMap.get(nodeId);
  if (!root) {
    throw new Error('Failed to build subtree');
  }

  return { root };
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
