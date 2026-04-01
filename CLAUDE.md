# Bulletflowy

Self-hosted Workflowy replacement — hierarchical bullet-point editor.

## Architecture

Monorepo with npm workspaces:

```
shared/          — TypeScript types (NodeRecord, TreeNode, User, etc.)
packages/server/ — Fastify 5 + better-sqlite3 backend
packages/client/ — Vanilla TypeScript + Vite frontend (no framework)
```

## Commands

```bash
npm run dev          # Start both server (tsx watch) and client (vite) concurrently
npm run build        # Build shared → client → server
npm start            # Run production server (serves client from packages/client/dist)
npm test             # Run server integration tests (vitest)
npm run lint         # Type-check server
```

Server runs on port 3001 by default (`PORT` env var). Client dev server proxies `/api` to the server.

## Database

SQLite via better-sqlite3. WAL mode, foreign keys ON. DB path: `BULLETFLOWY_DB` env var or `./bulletflowy.db`.

Schema: `users`, `sessions`, `passkeys`, `nodes` tables. Nodes use fractional indexing (`fractional-indexing` package) for ordering. UUIDv7 for all primary keys.

Tests use `:memory:` SQLite databases — no cleanup needed.

## Auth

Passkeys-first with password fallback. No external dependencies (no email/SMTP).

- Passwords hashed with argon2 (`@node-rs/argon2`)
- WebAuthn via `@simplewebauthn/server` + `@simplewebauthn/browser`
- Sessions stored in SQLite, delivered via httpOnly secure cookies (`bulletflowy_session`)
- 30-day session duration
- WebAuthn challenges stored in-memory (5-min TTL)
- Registration locked after first user (must be authenticated to register more users)
- First user adopts any orphaned pre-auth nodes

Auth middleware (`packages/server/src/middleware/auth.ts`) populates `request.user` from cookies on all routes, rejects unauthenticated requests on protected routes. Public routes: `/api/auth/me`, `/api/auth/register`, `/api/auth/login`, `/api/auth/passkey/login-*`.

Passkey RP config from env vars: `RP_ID` (default: localhost), `RP_NAME` (default: Bulletflowy), `ORIGIN` (default: http://localhost:3001).

## Multi-tenancy

All node queries scoped by `user_id`. Each user gets their own root node on registration. Users are fully isolated — cannot see each other's data.

## Key files

- `packages/server/src/db.ts` — Schema creation + migration (detects missing `user_id` column)
- `packages/server/src/services/node-service.ts` — CRUD, move (up/down/indent/outdent), split
- `packages/server/src/services/tree-service.ts` — Tree assembly, NotFoundError
- `packages/server/src/services/auth-service.ts` — User/session management
- `packages/server/src/services/passkey-service.ts` — WebAuthn ceremonies
- `packages/server/src/routes/auth.ts` — Auth endpoints
- `packages/server/src/middleware/auth.ts` — Session cookie middleware
- `packages/client/src/main.ts` — App entry, builds toolbar DOM dynamically after auth
- `packages/client/src/auth.ts` — Login/register UI, passkey flows
- `packages/client/src/tree-renderer.ts` — Main UI: renders tree, handles Enter/backspace/collapse
- `packages/client/src/keyboard.ts` — Global shortcuts (Cmd+K, Tab, Alt+arrows, etc.)
- `packages/client/src/action-bar.ts` — Search + command palette (/shortcuts, /dark, /light, etc.)
- `packages/client/src/theme.ts` — Dark/light mode toggle (shared between button + commands)
- `packages/client/src/style.css` — All styles, CSS custom properties for theming
- `shared/types.ts` — All shared TypeScript interfaces

## Frontend patterns

- All DOM built imperatively (createElement, appendChild). No innerHTML for security.
- contenteditable for inline text editing with debounced saves (300ms)
- Smart Enter: split at cursor, empty sibling above at start, first child at end with children
- Collapse/expand state persisted to localStorage (`bulletflowy-collapsed`)
- Theme preference persisted to localStorage (`bulletflowy-theme`)
- Action bar: search + `/` commands with Tab autocomplete
- Drag-and-drop via pointer events
- 401 responses trigger page reload → auth screen

## Testing

24 integration tests covering auth, CRUD, move operations, search, OPML import/export, completed filtering, node splitting, and multi-tenancy isolation. All tests authenticate via a helper that registers a user and extracts the session cookie.

## Phase status

- Phase 1 (single-user local): Complete
- Phase 2 auth + multi-tenancy: Complete
- Phase 2 remaining: GitHub repo, production deploy, CD pipeline, real-time sync, landing page
