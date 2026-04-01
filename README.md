# Bulletflowy

A self-hosted hierarchical bullet-point editor with no external dependencies.

## Features

- Infinite nested bullet points with drag-and-drop reordering
- Passkey (WebAuthn) authentication with password fallback
- Multi-user support with full data isolation
- Search and command palette (Cmd+K)
- OPML and plain-text import/export
- Collapse/expand, complete/uncomplete nodes
- Dark and light themes
- Notes/descriptions on any node
- Keyboard-driven: Tab/Shift+Tab to indent, Alt+arrows to move, Enter to split

## Tech stack

- **Frontend:** Vanilla TypeScript + Vite (no framework)
- **Backend:** Fastify 5 + better-sqlite3
- **Auth:** Passkeys via SimpleWebAuthn, argon2 password hashing
- **Database:** SQLite (WAL mode, fractional indexing for ordering)

## Getting started

```bash
# Install dependencies
npm install

# Start dev server (client + server with hot reload)
npm run dev
```

Open http://localhost:5173. Register your first user -- subsequent registrations require an authenticated user.

### Production

```bash
npm run build
npm start
```

The server runs on port 3001 by default (set `PORT` to change). In production, configure these environment variables for passkey support:

```
RP_ID=yourdomain.com
RP_NAME=Bulletflowy
ORIGIN=https://yourdomain.com
```

### Database

SQLite database is stored at `./bulletflowy.db` by default. Set `BULLETFLOWY_DB` to use a different path.

### Tests

```bash
npm test
```

Integration tests run against in-memory SQLite databases.

## Import/Export

- **OPML:** Standard outline format, compatible with Workflowy and other outliners
- **Plain text:** Indented bullet list with `[COMPLETE]` markers and `"quoted"` notes

Import via the toolbar button or `/import` command. Export via `/export` (OPML) or `/export-txt`.

## License

MIT
