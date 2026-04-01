import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { generateKeyBetween } from 'fractional-indexing';
import type { User } from '@bulletflowy/shared';

interface UserRow {
  id: string;
  username: string;
  password_hash: string | null;
  created_at: string;
}

function toUser(row: UserRow): User {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

export function hasAnyUsers(db: Database.Database): boolean {
  const row = db.prepare('SELECT 1 FROM users LIMIT 1').get();
  return !!row;
}

export async function createUser(
  db: Database.Database,
  username: string,
  password: string
): Promise<User> {
  const passwordHash = await hash(password);
  const id = uuidv7();

  const isFirstUser = !hasAnyUsers(db);

  db.prepare(
    'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'
  ).run(id, username, passwordHash);

  // Adopt orphaned nodes (from pre-auth era) for the first user
  if (isFirstUser) {
    const orphaned = db.prepare('SELECT id FROM nodes WHERE user_id IS NULL').all() as { id: string }[];
    if (orphaned.length > 0) {
      db.prepare('UPDATE nodes SET user_id = ? WHERE user_id IS NULL').run(id);
    }
  }

  // Ensure user has a root node
  const root = db.prepare('SELECT id FROM nodes WHERE parent_id IS NULL AND user_id = ?').get(id);
  if (!root) {
    const rootId = uuidv7();
    const pos = generateKeyBetween(null, null);
    db.prepare(
      'INSERT INTO nodes (id, parent_id, user_id, position, text) VALUES (?, NULL, ?, ?, ?)'
    ).run(rootId, id, pos, 'My Outline');
  }

  return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow);
}

export async function verifyPassword(
  db: Database.Database,
  username: string,
  password: string
): Promise<User | null> {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  if (!row || !row.password_hash) return null;

  const valid = await verify(row.password_hash, password);
  if (!valid) return null;

  return toUser(row);
}

export function getUserById(db: Database.Database, id: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

// Sessions

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createSession(db: Database.Database, userId: string): { sessionId: string; expiresAt: Date } {
  const sessionId = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(sessionId, userId, expiresAt.toISOString());

  return { sessionId, expiresAt };
}

export function getSession(db: Database.Database, sessionId: string): { userId: string } | null {
  const row = db.prepare(
    'SELECT user_id, expires_at FROM sessions WHERE id = ?'
  ).get(sessionId) as { user_id: string; expires_at: string } | undefined;

  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }

  return { userId: row.user_id };
}

export function deleteSession(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function cleanExpiredSessions(db: Database.Database): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").run();
}
