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

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function outlineToXml(node: TreeNode, indent: string): string {
  const attrs: string[] = [`text="${escapeXml(node.text)}"`];
  if (node.description) {
    attrs.push(`_note="${escapeXml(node.description)}"`);
  }
  if (node.status === 'completed') {
    attrs.push('_complete="true"');
  }

  if (node.children.length === 0) {
    return `${indent}<outline ${attrs.join(' ')}/>\n`;
  }

  let xml = `${indent}<outline ${attrs.join(' ')}>\n`;
  for (const child of node.children) {
    xml += outlineToXml(child, indent + '  ');
  }
  xml += `${indent}</outline>\n`;
  return xml;
}

export function exportOpml(db: Database.Database, userId: string): string {
  const rows = db.prepare('SELECT * FROM nodes WHERE user_id = ? ORDER BY position').all(userId) as DbRow[];

  const nodeMap = new Map<string, TreeNode>();
  const childrenMap = new Map<string | null, TreeNode[]>();
  let rootText = 'My Outline';

  for (const row of rows) {
    if (row.parent_id === null) {
      rootText = row.text;
    }

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

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<opml version="2.0">\n`;
  xml += `  <head>\n    <title>${escapeXml(rootText)}</title>\n  </head>\n`;
  xml += `  <body>\n`;
  for (const node of topLevel) {
    xml += outlineToXml(node, '    ');
  }
  xml += `  </body>\n</opml>\n`;

  return xml;
}
