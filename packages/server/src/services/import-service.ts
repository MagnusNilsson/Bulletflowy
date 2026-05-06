import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import { generateKeyBetween } from 'fractional-indexing';
import { XMLParser } from 'fast-xml-parser';

interface OpmlOutline {
  '@_text'?: string;
  '@__note'?: string;
  '@__complete'?: string;
  outline?: OpmlOutline | OpmlOutline[];
}

interface OpmlDoc {
  opml?: {
    body?: {
      outline?: OpmlOutline | OpmlOutline[];
    };
  };
}

function ensureArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

const MAX_IMPORT_DEPTH = 100;

function decodeXmlEntities(text: string): string {
  // Decode numeric entities (&#NN; and &#xNN;) first, then named entities.
  // &amp; is applied last so that literals like "&amp;lt;" survive as "&lt;".
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function insertOutlines(
  db: Database.Database,
  outlines: OpmlOutline[],
  parentId: string,
  userId: string,
  insertStmt: Database.Statement,
  depth: number = 0,
  startAfterPos: string | null = null
): number {
  if (depth > MAX_IMPORT_DEPTH) {
    throw new Error(`Import exceeds maximum nesting depth of ${MAX_IMPORT_DEPTH}`);
  }

  let count = 0;
  let prevPos: string | null = startAfterPos;

  for (const outline of outlines) {
    const id = uuidv7();
    const pos = generateKeyBetween(prevPos, null);
    const text = decodeXmlEntities(outline['@_text'] ?? '');
    const description = outline['@__note'] != null ? decodeXmlEntities(outline['@__note']) : null;
    const status = outline['@__complete'] === 'true' ? 'completed' : 'active';
    const now = new Date().toISOString();

    insertStmt.run(id, parentId, userId, pos, text, description, status, now, now);
    count++;
    prevPos = pos;

    const children = ensureArray(outline.outline);
    if (children.length > 0) {
      count += insertOutlines(db, children, id, userId, insertStmt, depth + 1);
    }
  }

  return count;
}

export function importOpml(
  db: Database.Database,
  userId: string,
  xmlContent: string,
  mode: 'replace' | 'merge'
): { importedCount: number } {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
  });

  const parsed = parser.parse(xmlContent) as OpmlDoc;
  const body = parsed?.opml?.body;
  if (!body) {
    throw new Error('Invalid OPML: missing <opml><body>');
  }

  const outlines = ensureArray(body.outline);

  const insertStmt = db.prepare(
    'INSERT INTO nodes (id, parent_id, user_id, position, text, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const importInTransaction = db.transaction(() => {
    const root = db.prepare('SELECT id FROM nodes WHERE parent_id IS NULL AND user_id = ?').get(userId) as { id: string };
    const rootId = root.id;

    if (mode === 'replace') {
      // Delete all non-root nodes for this user
      db.prepare('DELETE FROM nodes WHERE parent_id IS NOT NULL AND user_id = ?').run(userId);
    }

    let startAfterPos: string | null = null;
    if (mode === 'merge') {
      const lastChild = db.prepare(
        'SELECT position FROM nodes WHERE parent_id = ? AND user_id = ? ORDER BY position DESC LIMIT 1'
      ).get(rootId, userId) as { position: string } | undefined;
      startAfterPos = lastChild?.position ?? null;
    }

    return insertOutlines(db, outlines, rootId, userId, insertStmt, 0, startAfterPos);
  });

  const importedCount = importInTransaction();
  return { importedCount };
}
