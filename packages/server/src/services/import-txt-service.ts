import type Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import { generateKeyBetween } from 'fractional-indexing';

const MAX_IMPORT_DEPTH = 100;

interface StackEntry {
  depth: number;
  id: string;
  prevChildPos: string | null;
}

export function importTxt(
  db: Database.Database,
  userId: string,
  content: string,
  mode: 'replace' | 'merge'
): { importedCount: number } {
  const lines = content.split('\n');

  const insertStmt = db.prepare(
    'INSERT INTO nodes (id, parent_id, user_id, position, text, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const updateDescStmt = db.prepare(
    'UPDATE nodes SET description = ? WHERE id = ?'
  );

  const importInTransaction = db.transaction(() => {
    const root = db.prepare('SELECT id FROM nodes WHERE parent_id IS NULL AND user_id = ?').get(userId) as { id: string };
    const rootId = root.id;

    if (mode === 'replace') {
      db.prepare('DELETE FROM nodes WHERE parent_id IS NOT NULL AND user_id = ?').run(userId);
    }

    // Stack tracks ancestry: each entry is a node we can parent children under
    // Root is always at depth -1 so depth-0 bullets become its children
    let lastPosForRoot: string | null = null;
    if (mode === 'merge') {
      // Find the last position among existing root children
      const lastChild = db.prepare(
        'SELECT position FROM nodes WHERE parent_id = ? AND user_id = ? ORDER BY position DESC LIMIT 1'
      ).get(rootId, userId) as { position: string } | undefined;
      lastPosForRoot = lastChild?.position ?? null;
    }

    const stack: StackEntry[] = [{ depth: -1, id: rootId, prevChildPos: lastPosForRoot }];
    let lastInsertedId: string | null = null;
    let count = 0;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Check for note line (starts with optional whitespace then ")
      const noteMatch = line.match(/^(\s*)"/);
      if (noteMatch && lastInsertedId) {
        const noteLines: string[] = [];
        const noteIndent = noteMatch[1];

        // A `"` inside note content is written as `\"` by the exporter, so
        // only unescaped quotes close a note. Detect by counting trailing
        // backslashes before the final `"`.
        const endsWithUnescapedQuote = (s: string): boolean => {
          if (!s.endsWith('"')) return false;
          let backslashes = 0;
          for (let k = s.length - 2; k >= 0 && s[k] === '\\'; k--) backslashes++;
          return backslashes % 2 === 0;
        };

        // Check if single-line note: "content" with the closing quote unescaped
        const singleBody = line.slice(noteIndent.length + 1); // after opening "
        if (singleBody.length >= 1 && endsWithUnescapedQuote(singleBody)) {
          noteLines.push(singleBody.slice(0, -1));
          i++;
        } else {
          // Multi-line note: first line starts with ", last line is just "
          noteLines.push(singleBody);
          i++;

          while (i < lines.length) {
            const noteLine = lines[i];
            // Close marker: exactly the note indent followed by a single unescaped quote
            if (noteLine === noteIndent + '"') {
              i++;
              break;
            }
            // Strip the note indentation
            const stripped = noteLine.startsWith(noteIndent) ? noteLine.slice(noteIndent.length) : noteLine.trimStart();
            noteLines.push(stripped);
            i++;
          }
        }

        const description = noteLines
          .map(l => l.replace(/\\([\\"])/g, '$1'))
          .join('\n');
        if (description) {
          updateDescStmt.run(description, lastInsertedId);
        }
        continue;
      }

      // Check for bullet line
      const bulletMatch = line.match(/^(\s*)- (.*)$/);
      if (bulletMatch) {
        const indent = bulletMatch[1];
        const depth = Math.floor(indent.length / 2);
        let text = bulletMatch[2];
        let status: 'active' | 'completed' = 'active';

        if (text.startsWith('[COMPLETE] ')) {
          status = 'completed';
          text = text.slice('[COMPLETE] '.length);
        }

        if (depth > MAX_IMPORT_DEPTH) {
          throw new Error(`Import exceeds maximum nesting depth of ${MAX_IMPORT_DEPTH}`);
        }

        // Pop stack until we find a parent (entry with depth < current)
        while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
          stack.pop();
        }
        const parent = stack[stack.length - 1];

        const id = uuidv7();
        const pos = generateKeyBetween(parent.prevChildPos, null);
        const now = new Date().toISOString();

        insertStmt.run(id, parent.id, userId, pos, text, null, status, now, now);
        parent.prevChildPos = pos;
        count++;

        stack.push({ depth, id, prevChildPos: null });
        lastInsertedId = id;
        i++;
        continue;
      }

      // Skip empty or unrecognized lines
      i++;
    }

    return count;
  });

  const importedCount = importInTransaction();
  return { importedCount };
}
