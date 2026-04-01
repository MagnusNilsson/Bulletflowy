import Database from 'better-sqlite3';
import path from 'node:path';

const DB_PATH = process.env.BULLETFLOWY_DB ?? path.join(process.cwd(), 'bulletflowy.db');

export function createDatabase(dbPath: string = DB_PATH): Database.Database {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // New tables (auth)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS passkeys (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key  BLOB NOT NULL,
      counter     INTEGER NOT NULL DEFAULT 0,
      transports  TEXT,
      backed_up   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);
  `);

  // Nodes table (may already exist from Phase 1)
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id          TEXT PRIMARY KEY,
      parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      user_id     TEXT REFERENCES users(id),
      position    TEXT NOT NULL,
      text        TEXT NOT NULL DEFAULT '',
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_parent_position ON nodes(parent_id, position);
    CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
  `);

  // Migration: add user_id column to existing nodes table if missing
  const columns = db.prepare("PRAGMA table_info('nodes')").all() as { name: string }[];
  if (!columns.some(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE nodes ADD COLUMN user_id TEXT REFERENCES users(id)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id)');

  return db;
}
