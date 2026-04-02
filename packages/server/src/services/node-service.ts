import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import { generateKeyBetween } from 'fractional-indexing';
import type { NodeRecord, CreateNodeBody, UpdateNodeBody } from '@bulletflowy/shared';
import { NotFoundError } from './tree-service.js';

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

function toNodeRecord(row: DbRow): NodeRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    position: row.position,
    text: row.text,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getSiblings(db: Database.Database, userId: string, parentId: string): DbRow[] {
  return db.prepare(
    'SELECT * FROM nodes WHERE parent_id = ? AND user_id = ? ORDER BY position'
  ).all(parentId, userId) as DbRow[];
}

function getNode(db: Database.Database, userId: string, id: string): DbRow {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ? AND user_id = ?').get(id, userId) as DbRow | undefined;
  if (!row) throw new NotFoundError(`Node ${id} not found`);
  return row;
}

export function createNode(db: Database.Database, userId: string, body: CreateNodeBody): NodeRecord {
  const { parentId, text, description } = body;

  // Verify parent exists and belongs to user
  getNode(db, userId, parentId);

  let position = body.position;
  if (position === 'first') {
    const siblings = getSiblings(db, userId, parentId);
    const firstPos = siblings.length > 0 ? siblings[0].position : null;
    position = generateKeyBetween(null, firstPos);
  } else if (body.afterId) {
    // Insert immediately after the specified sibling
    const siblings = getSiblings(db, userId, parentId);
    const idx = siblings.findIndex(s => s.id === body.afterId);
    if (idx === -1) throw new NotFoundError(`Node ${body.afterId} not found among siblings`);
    const after = siblings[idx].position;
    const before = idx < siblings.length - 1 ? siblings[idx + 1].position : null;
    position = generateKeyBetween(after, before);
  } else if (body.beforeId) {
    // Insert immediately before the specified sibling
    const siblings = getSiblings(db, userId, parentId);
    const idx = siblings.findIndex(s => s.id === body.beforeId);
    if (idx === -1) throw new NotFoundError(`Node ${body.beforeId} not found among siblings`);
    const before = siblings[idx].position;
    const after = idx > 0 ? siblings[idx - 1].position : null;
    position = generateKeyBetween(after, before);
  } else if (!position) {
    const siblings = getSiblings(db, userId, parentId);
    const lastPos = siblings.length > 0 ? siblings[siblings.length - 1].position : null;
    position = generateKeyBetween(lastPos, null);
  }

  const id = body.id ?? uuidv7();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO nodes (id, parent_id, user_id, position, text, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, parentId, userId, position, text, description ?? null, now, now);

  return toNodeRecord(getNode(db, userId, id));
}

export function updateNode(db: Database.Database, userId: string, id: string, body: UpdateNodeBody): NodeRecord {
  const node = getNode(db, userId, id);

  // Don't allow modifying root's parentId
  if (node.parent_id === null && body.parentId !== undefined) {
    throw new Error('Cannot move the root node');
  }

  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.text !== undefined) {
    sets.push('text = ?');
    values.push(body.text);
  }
  if (body.description !== undefined) {
    sets.push('description = ?');
    values.push(body.description);
  }
  if (body.parentId !== undefined) {
    // Verify new parent exists and belongs to user
    getNode(db, userId, body.parentId);
    sets.push('parent_id = ?');
    values.push(body.parentId);
  }
  if (body.afterId) {
    const newParentId = body.parentId ?? node.parent_id!;
    const siblings = getSiblings(db, userId, newParentId);
    const idx = siblings.findIndex(s => s.id === body.afterId);
    if (idx === -1) throw new NotFoundError(`Node ${body.afterId} not found among siblings`);
    const after = siblings[idx].position;
    const before = idx < siblings.length - 1 ? siblings[idx + 1].position : null;
    sets.push('position = ?');
    values.push(generateKeyBetween(after, before));
  } else if (body.beforeId) {
    const newParentId = body.parentId ?? node.parent_id!;
    const siblings = getSiblings(db, userId, newParentId);
    const idx = siblings.findIndex(s => s.id === body.beforeId);
    if (idx === -1) throw new NotFoundError(`Node ${body.beforeId} not found among siblings`);
    const before = siblings[idx].position;
    const after = idx > 0 ? siblings[idx - 1].position : null;
    sets.push('position = ?');
    values.push(generateKeyBetween(after, before));
  } else if (body.position !== undefined) {
    sets.push('position = ?');
    values.push(body.position);
  }
  if (body.status !== undefined) {
    sets.push('status = ?');
    values.push(body.status);
  }

  if (sets.length === 0) {
    return toNodeRecord(node);
  }

  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  values.push(id);

  db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  return toNodeRecord(getNode(db, userId, id));
}

export function deleteNode(db: Database.Database, userId: string, id: string): { deletedCount: number } {
  const node = getNode(db, userId, id);
  if (node.parent_id === null) {
    throw new Error('Cannot delete the root node');
  }

  // Count descendants (including self)
  const countResult = db.prepare(`
    WITH RECURSIVE descendants AS (
      SELECT id FROM nodes WHERE id = ? AND user_id = ?
      UNION ALL
      SELECT n.id FROM nodes n INNER JOIN descendants d ON n.parent_id = d.id
    ) SELECT COUNT(*) as count FROM descendants
  `).get(id, userId) as { count: number };

  db.prepare('DELETE FROM nodes WHERE id = ? AND user_id = ?').run(id, userId);

  return { deletedCount: countResult.count };
}

export function moveNode(
  db: Database.Database,
  userId: string,
  id: string,
  direction: 'up' | 'down' | 'indent' | 'outdent'
): NodeRecord {
  const node = getNode(db, userId, id);
  if (node.parent_id === null) {
    throw new Error('Cannot move the root node');
  }

  const siblings = getSiblings(db, userId, node.parent_id);
  const idx = siblings.findIndex(s => s.id === id);

  switch (direction) {
    case 'up': {
      if (idx <= 0) throw new Error('Already at the top');
      const prev = siblings[idx - 1];
      db.prepare('UPDATE nodes SET position = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?').run(prev.position, id);
      db.prepare('UPDATE nodes SET position = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?').run(node.position, prev.id);
      break;
    }
    case 'down': {
      if (idx >= siblings.length - 1) throw new Error('Already at the bottom');
      const next = siblings[idx + 1];
      db.prepare('UPDATE nodes SET position = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?').run(next.position, id);
      db.prepare('UPDATE nodes SET position = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?').run(node.position, next.id);
      break;
    }
    case 'indent': {
      if (idx <= 0) throw new Error('No previous sibling to indent under');
      const newParent = siblings[idx - 1];
      const newSiblings = getSiblings(db, userId, newParent.id);
      const lastPos = newSiblings.length > 0 ? newSiblings[newSiblings.length - 1].position : null;
      const newPos = generateKeyBetween(lastPos, null);
      db.prepare(
        'UPDATE nodes SET parent_id = ?, position = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?'
      ).run(newParent.id, newPos, id);
      break;
    }
    case 'outdent': {
      const parent = getNode(db, userId, node.parent_id);
      if (parent.parent_id === null) {
        throw new Error('Cannot outdent from top level');
      }
      const parentSiblings = getSiblings(db, userId, parent.parent_id);
      const parentIdx = parentSiblings.findIndex(s => s.id === parent.id);
      const after = parentSiblings[parentIdx]?.position ?? null;
      const before = parentIdx < parentSiblings.length - 1 ? parentSiblings[parentIdx + 1].position : null;
      const newPos = generateKeyBetween(after, before);
      db.prepare(
        'UPDATE nodes SET parent_id = ?, position = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?'
      ).run(parent.parent_id, newPos, id);
      break;
    }
  }

  return toNodeRecord(getNode(db, userId, id));
}

export function splitNode(
  db: Database.Database,
  userId: string,
  id: string,
  textBefore: string,
  textAfter: string,
  clientNewId?: string
): { original: NodeRecord; created: NodeRecord } {
  const node = getNode(db, userId, id);
  if (node.parent_id === null) {
    throw new Error('Cannot split the root node');
  }

  const siblings = getSiblings(db, userId, node.parent_id);
  const idx = siblings.findIndex(s => s.id === id);
  const after = node.position;
  const before = idx < siblings.length - 1 ? siblings[idx + 1].position : null;
  const newPos = generateKeyBetween(after, before);

  const newId = clientNewId ?? uuidv7();
  const now = new Date().toISOString();

  const doSplit = db.transaction(() => {
    // Update original node text
    db.prepare(
      "UPDATE nodes SET text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(textBefore, id);

    // Create new sibling
    db.prepare(
      'INSERT INTO nodes (id, parent_id, user_id, position, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(newId, node.parent_id, userId, newPos, textAfter, now, now);

    // Move all children of original to the new node
    db.prepare(
      "UPDATE nodes SET parent_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE parent_id = ? AND id != ?"
    ).run(newId, id, newId);
  });

  doSplit();

  return {
    original: toNodeRecord(getNode(db, userId, id)),
    created: toNodeRecord(getNode(db, userId, newId)),
  };
}
