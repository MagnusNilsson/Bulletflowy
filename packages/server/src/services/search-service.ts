import type Database from 'better-sqlite3';
import type { SearchResult } from '@bulletflowy/shared';

interface DbRow {
  id: string;
  parent_id: string | null;
  text: string;
  description: string | null;
  status: 'active' | 'completed';
}

export function searchNodes(db: Database.Database, userId: string, query: string): SearchResult[] {
  if (!query.trim()) return [];

  const pattern = `%${query}%`;

  const rows = db.prepare(`
    SELECT id, parent_id, text, description, status
    FROM nodes
    WHERE user_id = ?
      AND (text LIKE ? OR description LIKE ?)
      AND parent_id IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 50
  `).all(userId, pattern, pattern) as DbRow[];

  // Build ancestor lookup for breadcrumbs (only this user's nodes)
  const allNodes = db.prepare('SELECT id, parent_id, text FROM nodes WHERE user_id = ?').all(userId) as DbRow[];
  const nodeMap = new Map(allNodes.map(n => [n.id, n]));

  return rows.map(row => {
    const breadcrumbs: { id: string; text: string }[] = [];
    let current = nodeMap.get(row.parent_id!);
    while (current && current.parent_id !== null) {
      breadcrumbs.unshift({ id: current.id, text: current.text });
      current = current.parent_id ? nodeMap.get(current.parent_id) : undefined;
    }

    return {
      id: row.id,
      text: row.text,
      description: row.description,
      status: row.status,
      breadcrumbs,
    };
  });
}
