import type Database from 'better-sqlite3';

interface DbRow {
  id: string;
  parent_id: string | null;
  position: string;
  text: string;
  description: string | null;
  status: 'active' | 'completed';
}

interface TreeNode {
  text: string;
  description: string | null;
  status: string;
  children: TreeNode[];
}

function escapeNoteLine(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function nodeToTxt(node: TreeNode, depth: number): string {
  const indent = '  '.repeat(depth);
  const prefix = node.status === 'completed' ? '[COMPLETE] ' : '';
  let txt = `${indent}- ${prefix}${node.text}\n`;

  if (node.description) {
    const noteIndent = '  '.repeat(depth) + '  ';
    const lines = node.description.split('\n').map(escapeNoteLine);
    if (lines.length === 1) {
      txt += `${noteIndent}"${lines[0]}"\n`;
    } else {
      txt += `${noteIndent}"${lines[0]}\n`;
      for (let i = 1; i < lines.length; i++) {
        txt += `${noteIndent}${lines[i]}\n`;
      }
      txt += `${noteIndent}"\n`;
    }
  }

  for (const child of node.children) {
    txt += nodeToTxt(child, depth + 1);
  }

  return txt;
}

export function exportTxt(db: Database.Database, userId: string): string {
  const rows = db.prepare('SELECT * FROM nodes WHERE user_id = ? ORDER BY position').all(userId) as DbRow[];

  const nodeMap = new Map<string, TreeNode>();
  const childrenMap = new Map<string | null, TreeNode[]>();

  for (const row of rows) {
    const treeNode: TreeNode = {
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
      if (parent) parent.children = children;
    }
  }

  const topLevel = childrenMap.get(null)?.[0]?.children ?? [];

  let txt = '';
  for (const node of topLevel) {
    txt += nodeToTxt(node, 0);
  }

  return txt;
}
