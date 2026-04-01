# PRD: Bulletflowy — A Workflowy Replacement

## Overview

Bulletflowy is a self-hosted hierarchical bullet-point editor that replaces Workflowy Pro. It stores an infinitely nestable tree of nodes and exposes it through a fast, keyboard-first web UI with full drag-and-drop support. Phase 1 runs locally with no authentication. Phase 2 adds passwordless auth, real-time multi-client sync, and a public landing page.

---

## Guiding Principles

- **Correct, secure, clear, maintainable, efficient** — in that order.
- Prefer simple, explicit solutions over clever ones.
- Strong typing everywhere (TypeScript on both ends).
- Concerns separated; side effects at the boundaries.
- Remove real duplication; do not over-abstract.
- Validate all external input. Handle errors explicitly with useful context.
- No work is complete unless it builds, passes checks, and changed behaviour is tested.

---

## Phase 1 — Local Single-User Bulletflowy

### 1. Data Model

A single tree. Every item is a **node**.

#### Node fields

| Field         | Type      | Description |
|---------------|-----------|-------------|
| `id`          | UUID v7   | Primary key. Time-sortable. |
| `parentId`    | UUID | null | `null` for the single root node. |
| `position`    | string    | Fractional-index string for sibling ordering (see Ordering below). |
| `text`        | string    | The main content. Plain text, no rich formatting. |
| `description` | string | null | Optional note displayed *above* the text in a smaller, muted style. |
| `status`      | enum      | `active`, `completed`. |
| `createdAt`   | ISO 8601  | |
| `updatedAt`   | ISO 8601  | |

There is no `deleted` status. Deletion is hard-delete (the node and all descendants are removed from the database).

#### Root node

There is exactly one root node (`parentId = null`). It is created on first boot if it does not exist. The root node's `text` serves as the document title. The root node itself is never rendered as a bullet; its children are the top-level list.

#### Ordering — Fractional Indexing

Sibling order uses fractional-index strings (e.g. the `fractional-indexing` npm package). This gives O(1) insert/move with no renumbering of siblings. The `position` column is a text column with a btree index on `(parentId, position)`.

#### Tree operations

| Operation | Effect |
|-----------|--------|
| Create node | Insert as last child of target parent (generate position after last sibling). |
| Move node | Update `parentId` and `position`. Moving a node moves the entire subtree. |
| Indent (Tab) | Reparent node under its immediately preceding sibling (becomes last child). |
| Outdent (Shift-Tab) | Reparent node under its parent's parent, positioned immediately after its former parent. |
| Move up | Swap `position` with previous sibling (same parent). |
| Move down | Swap `position` with next sibling (same parent). |
| Complete | Set `status = completed`. |
| Delete | Hard-delete node and all descendants. |

### 2. Backend

#### Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Node.js 22+ | Matches existing stack. |
| Framework | Fastify 5 | Fast, schema-validated, plugin-based. Matches existing stack. |
| Database | SQLite via `better-sqlite3` | Zero-config, single file, perfect for local single-user. Adequate for 5k nodes. Migrating to Postgres in Phase 2 is straightforward. |
| Typing | TypeScript (strict mode) | |

#### Schema (SQLite)

```sql
CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,          -- UUID v7
  parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  position    TEXT NOT NULL,             -- fractional index
  text        TEXT NOT NULL DEFAULT '',
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_nodes_parent_position ON nodes(parent_id, position);
CREATE INDEX idx_nodes_status ON nodes(status);
```

`ON DELETE CASCADE` ensures deleting a parent removes the entire subtree atomically.

#### API (REST + JSON)

All request/response bodies are validated with Fastify JSON schemas.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tree` | Return the full tree. Query param `?includeCompleted=true` to include completed nodes. Response is a nested JSON structure (see below). |
| `POST` | `/api/nodes` | Create a node. Body: `{ parentId, text, description?, position? }`. If `position` is omitted, append as last child. |
| `PATCH` | `/api/nodes/:id` | Update node fields. Body may contain any subset of: `{ text, description, parentId, position, status }`. Changing `parentId` and/or `position` is a move. |
| `DELETE` | `/api/nodes/:id` | Delete node and all descendants. Returns `{ deletedCount }`. |
| `POST` | `/api/nodes/:id/move` | Structured move. Body: `{ direction: 'up' | 'down' | 'indent' | 'outdent' }`. Server computes new parentId/position. Returns updated node. |
| `POST` | `/api/import/opml` | Import a Workflowy OPML export. Multipart file upload. Replaces or merges into tree (query param `?mode=replace|merge`, default `replace`). |
| `GET` | `/api/search?q=...` | Full-text search across `text` and `description` of active nodes. Returns flat list of matching nodes with breadcrumb ancestry. |

#### Tree response shape

```jsonc
{
  "root": {
    "id": "...",
    "text": "My Outline",
    "description": null,
    "status": "active",
    "children": [
      {
        "id": "...",
        "text": "First item",
        "description": "A note about this item",
        "status": "active",
        "children": [ /* ... */ ]
      }
    ]
  }
}
```

The backend assembles the tree from the flat table in-memory. At ≤5k nodes this is trivially fast.

#### OPML Import

Workflowy exports as OPML (`.opml` XML file). The importer:

1. Parses the XML.
2. Walks `<outline>` elements recursively.
3. Maps `text` attribute → `text`, `_note` attribute → `description`.
4. Maps `_complete="true"` → `status: completed`.
5. Preserves hierarchy.
6. Wraps the entire import in a single SQLite transaction.
7. In `replace` mode: deletes all existing nodes, then inserts the imported tree.
8. In `merge` mode: inserts the imported tree as children of the root.

#### Error handling

All errors return JSON `{ error: string, details?: any }` with appropriate HTTP status codes. Validation errors return 400 with field-level detail. Not-found returns 404. Internal errors return 500 with a generic message (details logged server-side only).

### 3. Frontend

#### Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Language | TypeScript | Type safety. |
| Framework | Vanilla TS + DOM API | The UI is a single tree — no component model needed. Minimal bundle, fast paint. |
| Bundler | Vite | Fast dev server, minimal config. |
| CSS | Single CSS file, custom properties for theming | Keep it simple. |

#### Layout

```
┌──────────────────────────────────────────────────┐
│  [Search field]              [☑ Show completed]  │
│  ─────────────────────────────────────────────── │
│  Breadcrumb: Root > Parent > Current             │
│  ─────────────────────────────────────────────── │
│                                                  │
│  • Node text                                     │
│    small muted description                       │
│    • Child node                                  │
│    • Child node                                  │
│      • Grandchild                                │
│  • Another node                                  │
│  ✓ Completed node (dimmed, only if toggled on)   │
│                                                  │
└──────────────────────────────────────────────────┘
```

Wait — the description is *above* the text:

```
│    small muted description                       │
│  • Node text                                     │
```

#### Node rendering

Each node renders as:

```html
<div class="node" data-id="..." data-status="active|completed">
  <div class="node-description">Optional description text</div>
  <div class="node-content">
    <span class="node-bullet">•</span>
    <span class="node-text" contenteditable="true">Node text</span>
  </div>
  <div class="node-children">
    <!-- child nodes indented -->
  </div>
</div>
```

- Indentation is structural (nested `div.node-children`) plus CSS `padding-left`.
- Completed nodes get `class="node completed"` and are hidden by default, shown when the toggle is active.
- The bullet `•` is clickable to zoom into that node.

#### Zoom (node-as-root)

Clicking a node's bullet zooms into it: that node becomes the visual root, and a breadcrumb trail shows the path from the actual root. Clicking any breadcrumb segment zooms to that ancestor. The URL updates to `#nodeId` so the zoomed state survives refresh.

#### Keyboard navigation

The Bulletflowy is keyboard-first. The currently focused node has a visible focus indicator.

| Key | Action |
|-----|--------|
| `Enter` | Create a new sibling node below the current one. Focus moves to the new node. |
| `Tab` | Indent: reparent current node under its previous sibling. |
| `Shift+Tab` | Outdent: reparent current node under grandparent, after parent. |
| `↑` / `↓` | Move focus to the previous/next visible node (depth-first order). |
| `Alt+↑` / `Alt+↓` | Move the current node up/down among its siblings. |
| `Backspace` on empty node | Delete the node. Focus moves to previous sibling or parent. |
| `Escape` | Blur the current node / close search. |
| `Ctrl+Enter` or `Cmd+Enter` | Toggle complete/active on the focused node. |
| `/` (when no node is focused) | Focus the search field. |

All keyboard shortcuts work while a node's text is being edited via `contenteditable`. `Tab` and `Shift+Tab` are intercepted to prevent default browser behaviour.

#### Drag and drop

Drag and drop works with both mouse and touch. It changes both sibling order and hierarchy depth in a single gesture.

**Interaction model:**

1. User presses and holds a node's bullet or a dedicated drag handle (≈ 6-dot grip icon to the left of the bullet).
2. The node (and its subtree) becomes a floating "ghost" element following the pointer.
3. As the pointer moves over other nodes, a **drop indicator** appears — a horizontal line showing exactly where the dragged node will land:
   - The line's **vertical position** shows the insertion point (between which siblings).
   - The line's **horizontal indentation** shows the target depth (which parent it will become a child of).
   - Indentation snaps to valid positions: the drop target can be at the depth of the node above the line, or indented one level deeper (becoming a child of the node above).
4. On release, the node is moved to the indicated position via `POST /api/nodes/:id/move` or `PATCH /api/nodes/:id`.

**Touch-specific:**

- Long-press (300ms) initiates drag on touch devices (to distinguish from scroll).
- During drag, the page scrolls automatically when the touch point is near the top/bottom edge.
- The drop indicator is large enough to be finger-friendly (≥ 44px touch target zones).

**Implementation notes:**

- Use the native HTML Drag and Drop API for mouse, with a `PointerEvent`-based fallback for touch (or use pointer events throughout for unified handling).
- Actually: **use Pointer Events exclusively** for a unified mouse+touch implementation. The native DnD API is poorly suited for custom drop indicators with variable indentation.

#### Inline editing

Node text is edited in-place using `contenteditable`. Changes are debounced (300ms) and sent via `PATCH /api/nodes/:id`. The frontend does not use a full two-way sync model in Phase 1 — it is the source of truth during editing and reconciles with the server response.

#### Search

The search field (top of page) sends `GET /api/search?q=...` debounced at 200ms. Results appear as a flat list of matching nodes, each showing its text, description, and breadcrumb path. Clicking a result zooms to that node in the tree.

#### Synching

Any changes in the editor should be saved continuously. Show a subtle feedback when saving succeeds. Less subtle if it fails.

#### OPML Import UI

A simple "Import" button (in a toolbar or settings area) opens a file picker for `.opml` files. On selection, the file is uploaded to `POST /api/import/opml`. A confirmation dialog warns that `replace` mode will delete existing data.

#### Styling

- Clean, minimal. White/off-white background, dark text.
- Monospace or system sans-serif font for node text.
- Description text: 80% size, muted color (e.g. `#888`), displayed above the node text.
- Completed nodes: struck-through text, reduced opacity.
- Focused node: subtle left-border highlight or background tint.
- Drop indicator: 2px solid blue line with a small circle at the left end indicating depth.
- Responsive: works on narrow viewports (mobile browser) even before native app exists.
- Dark mode via `prefers-color-scheme` media query and CSS custom properties. Not a toggle — just respects OS setting.

### 4. Project Structure

```
Bulletflowy/
├── package.json              # workspace root
├── tsconfig.base.json
├── packages/
│   ├── server/
│   │   ├── src/
│   │   │   ├── index.ts           # Fastify entry point
│   │   │   ├── db.ts              # SQLite setup + migrations
│   │   │   ├── routes/
│   │   │   │   ├── tree.ts
│   │   │   │   ├── nodes.ts
│   │   │   │   ├── import.ts
│   │   │   │   └── search.ts
│   │   │   ├── services/
│   │   │   │   ├── tree-service.ts
│   │   │   │   ├── node-service.ts
│   │   │   │   ├── import-service.ts  # OPML parsing + insertion
│   │   │   │   └── search-service.ts
│   │   │   └── types.ts
│   │   ├── test/
│   │   └── tsconfig.json
│   └── client/
│       ├── index.html
│       ├── src/
│       │   ├── main.ts
│       │   ├── api.ts             # fetch wrappers
│       │   ├── tree-renderer.ts   # DOM rendering
│       │   ├── keyboard.ts        # keyboard handler
│       │   ├── drag-drop.ts       # pointer-event based DnD
│       │   ├── search.ts
│       │   ├── types.ts           # shared types
│       │   └── style.css
│       ├── test/
│       └── tsconfig.json
├── shared/
│   └── types.ts                   # Node, TreeResponse, etc.
```

Monorepo with npm workspaces. Shared types package used by both server and client.

### 5. Testing

- **Server:** Vitest. Unit tests for tree-service (move, indent, outdent, delete cascade), import-service (OPML parsing with various edge cases), search. Integration tests hitting the Fastify routes with an in-memory SQLite DB.
- **Client:** Vitest + jsdom or happy-dom. Unit tests for tree rendering logic, keyboard handler mapping, fractional index calculations. E2E tests are deferred to Phase 2.
- **OPML import:** Test with an actual Workflowy export. Cover: nested hierarchies (at least 5 levels deep), nodes with `_note` attributes, completed nodes, empty nodes, special characters / Unicode in node text.

### 6. Development & Running

```bash
# Install
npm install

# Dev (runs server + client with hot reload)
npm run dev

# Server: localhost:3001 (API)
# Client: localhost:5173 (Vite dev server, proxies /api to :3001)

# Test
npm test

# Build for production
npm run build
npm start  # serves client static files from the Fastify server
```

The Fastify server, in production mode, serves the built Vite client assets from a `public/` directory, so the whole app runs as a single process.

---

## Phase 2 — Multi-User with Auth (Future)

Included here for architectural awareness. Phase 1 decisions should not block these.

### Authentication

- Passwordless only. Email magic link and/or WebAuthn passkeys.
- 2FA required (passkey counts as 2FA inherently; email flow adds TOTP or passkey as second factor).
- Session management via secure, httpOnly, SameSite cookies.
- No password storage, ever.

### Multi-tenancy

- `users` table. Each `node` gets a `user_id` FK.
- The root node is per-user.
- Migrate from SQLite to PostgreSQL. The adjacency-list + fractional-index model ports directly.

### Real-time sync

- WebSocket connection (Fastify `@fastify/websocket`).
- Server broadcasts node mutations to all connected clients of the same user.
- Client applies remote changes to the DOM tree. Conflicts resolved by last-write-wins on a per-node basis (sufficient for single-user-multi-device).
- if saving is not working, temp store in local storage and attempt server save later. Indicate to user that connection to server is lost, and edits are not saved.

### Landing page

- Static HTML page at `/` for non-authenticated visitors.
- Describes the service, links to sign up / sign in.
- The app lives at `/app`.

### iOS app (future)

- The API is already JSON REST — a native Swift client can consume it directly.
- WebSocket support enables real-time updates.
- Consider sharing the `shared/types.ts` definitions via OpenAPI spec generated from Fastify schemas, then use a Swift codegen tool.

---

## Non-Goals (Explicit Exclusions)

These are Workflowy features we are deliberately **not** building:

- Rich text / Markdown formatting in nodes
- Tags / hashtags
- Mirrors / references (a node appearing in multiple places)
- Sharing / collaboration
- Kanban / board view
- File attachments or images in nodes
- Version history / undo beyond browser-level undo in contenteditable
- Offline-first / local-first sync (the server is the source of truth)

---

## Open Questions

1. **Undo/redo:** Workflowy has multi-level undo. Do we want an operation log for server-side undo, or is browser-level undo within `contenteditable` sufficient for Phase 1? *Recommendation: defer server-side undo to Phase 2. Browser undo handles text edits. Structural operations (move, delete) are intentional and less likely to need undo.*

2. **Export:** Should Phase 1 include OPML export (round-trip), or is import sufficient? *Recommendation: add export — it's trivial once the tree is in memory and provides data portability.*

3. **Bulk operations:** Multi-select nodes for bulk delete/complete/move? *Recommendation: defer. Single-node operations cover the core workflow.*
