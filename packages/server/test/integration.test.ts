import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/index.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let cookie: string;

async function registerAndGetCookie(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'testuser', password: 'testpass123' },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'] as string;
  // Extract just the cookie name=value
  return setCookie.split(';')[0];
}

function inject(opts: { method: string; url: string; payload?: unknown }) {
  return app.inject({
    ...opts,
    headers: { cookie },
  });
}

beforeEach(async () => {
  app = await buildApp(':memory:');
  cookie = await registerAndGetCookie();
});

afterEach(async () => {
  await app.close();
});

describe('Auth', () => {
  it('GET /api/auth/me returns user when authenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toBeDefined();
    expect(body.user.username).toBe('testuser');
    expect(body.setupRequired).toBe(false);
  });

  it('returns 401 for unauthenticated API requests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tree',
    });
    expect(res.statusCode).toBe(401);
  });

  it('login with correct credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'testuser', password: 'testpass123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe('testuser');
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('login with wrong password returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'testuser', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('prevents registration when users exist and not authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'another', password: 'testpass123' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('logout clears session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    // Now the cookie should be invalid
    const res = await app.inject({
      method: 'GET',
      url: '/api/tree',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/tree', () => {
  it('returns root with empty children', async () => {
    const res = await inject({ method: 'GET', url: '/api/tree' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.root).toBeDefined();
    expect(body.root.text).toBe('My Outline');
    expect(body.root.children).toEqual([]);
  });
});

describe('POST /api/nodes', () => {
  it('creates a child of root', async () => {
    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    const rootId = tree.root.id;

    const res = await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'First item' },
    });
    expect(res.statusCode).toBe(201);
    const node = res.json();
    expect(node.text).toBe('First item');
    expect(node.parentId).toBe(rootId);

    // Verify tree
    const tree2 = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(tree2.root.children).toHaveLength(1);
    expect(tree2.root.children[0].text).toBe('First item');
  });

  it('returns 404 for non-existent parent', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: 'nonexistent', text: 'test' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/nodes/:id', () => {
  it('updates node text', async () => {
    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    const rootId = tree.root.id;

    const created = (await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'Original' },
    })).json();

    const res = await inject({
      method: 'PATCH',
      url: `/api/nodes/${created.id}`,
      payload: { text: 'Updated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe('Updated');
  });

  it('toggles status to completed', async () => {
    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    const rootId = tree.root.id;

    const created = (await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'Task' },
    })).json();

    const res = await inject({
      method: 'PATCH',
      url: `/api/nodes/${created.id}`,
      payload: { status: 'completed' },
    });
    expect(res.json().status).toBe('completed');
  });
});

describe('DELETE /api/nodes/:id', () => {
  it('deletes node and descendants', async () => {
    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    const rootId = tree.root.id;

    const parent = (await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'Parent' },
    })).json();

    await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: parent.id, text: 'Child' },
    });

    const res = await inject({
      method: 'DELETE',
      url: `/api/nodes/${parent.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deletedCount).toBe(2);

    const tree2 = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(tree2.root.children).toHaveLength(0);
  });
});

describe('POST /api/nodes/:id/move', () => {
  async function createNodes() {
    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    const rootId = tree.root.id;

    const a = (await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'A' },
    })).json();

    const b = (await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'B' },
    })).json();

    const c = (await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'C' },
    })).json();

    return { rootId, a, b, c };
  }

  it('moves node down', async () => {
    const { a } = await createNodes();

    const res = await inject({
      method: 'POST',
      url: `/api/nodes/${a.id}/move`,
      payload: { direction: 'down' },
    });
    expect(res.statusCode).toBe(200);

    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(tree.root.children[0].text).toBe('B');
    expect(tree.root.children[1].text).toBe('A');
  });

  it('moves node up', async () => {
    const { b } = await createNodes();

    await inject({
      method: 'POST',
      url: `/api/nodes/${b.id}/move`,
      payload: { direction: 'up' },
    });

    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(tree.root.children[0].text).toBe('B');
    expect(tree.root.children[1].text).toBe('A');
  });

  it('indents node under previous sibling', async () => {
    const { b } = await createNodes();

    await inject({
      method: 'POST',
      url: `/api/nodes/${b.id}/move`,
      payload: { direction: 'indent' },
    });

    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(tree.root.children).toHaveLength(2);
    expect(tree.root.children[0].text).toBe('A');
    expect(tree.root.children[0].children[0].text).toBe('B');
  });

  it('outdents node to grandparent', async () => {
    const { a, b } = await createNodes();

    await inject({
      method: 'POST',
      url: `/api/nodes/${b.id}/move`,
      payload: { direction: 'indent' },
    });

    await inject({
      method: 'POST',
      url: `/api/nodes/${b.id}/move`,
      payload: { direction: 'outdent' },
    });

    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(tree.root.children).toHaveLength(3);
    expect(tree.root.children[0].text).toBe('A');
    expect(tree.root.children[1].text).toBe('B');
  });

  it('returns 400 when moving up from first position', async () => {
    const { a } = await createNodes();

    const res = await inject({
      method: 'POST',
      url: `/api/nodes/${a.id}/move`,
      payload: { direction: 'up' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/search', () => {
  it('finds nodes by text', async () => {
    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    const rootId = tree.root.id;

    await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'Meeting notes for Monday' },
    });

    await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'Shopping list' },
    });

    const res = await inject({
      method: 'GET',
      url: '/api/search?q=meeting',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].text).toBe('Meeting notes for Monday');
  });

  it('excludes children of completed nodes when includeCompleted is false', async () => {
    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    const rootId = tree.root.id;

    // Create a parent node, then complete it
    const parent = (await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'Done project' },
    })).json();

    await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: parent.id, text: 'searchable child under completed' },
    });

    await inject({
      method: 'PATCH',
      url: `/api/nodes/${parent.id}`,
      payload: { status: 'completed' },
    });

    // Without includeCompleted: child should not appear
    const res1 = (await inject({ method: 'GET', url: '/api/search?q=searchable+child' })).json();
    expect(res1.results).toHaveLength(0);

    // With includeCompleted: child should appear
    const res2 = (await inject({ method: 'GET', url: '/api/search?q=searchable+child&includeCompleted=true' })).json();
    expect(res2.results).toHaveLength(1);
  });
});

describe('OPML import/export', () => {
  const sampleOpml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test</title></head>
  <body>
    <outline text="Item 1" _note="A note">
      <outline text="Child 1.1"/>
      <outline text="Child 1.2" _complete="true"/>
    </outline>
    <outline text="Item 2"/>
  </body>
</opml>`;

  it('imports OPML in replace mode', async () => {
    const { importOpml } = await import('../src/services/import-service.js');
    // Get user ID from the me endpoint
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    const userId = me.user.id;

    const result = importOpml(app.db, userId, sampleOpml, 'replace');
    expect(result.importedCount).toBe(4);

    const tree = (await inject({ method: 'GET', url: '/api/tree?includeCompleted=true' })).json();
    expect(tree.root.children).toHaveLength(2);
    expect(tree.root.children[0].text).toBe('Item 1');
    expect(tree.root.children[0].children).toHaveLength(2);
    expect(tree.root.children[0].children[0].text).toBe('Child 1.1');
    expect(tree.root.children[0].children[1].status).toBe('completed');
  });

  it('exports OPML round-trip', async () => {
    const { importOpml } = await import('../src/services/import-service.js');
    const { exportOpml } = await import('../src/services/export-service.js');
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    const userId = me.user.id;

    importOpml(app.db, userId, sampleOpml, 'replace');
    const xml = exportOpml(app.db, userId);

    expect(xml).toContain('Item 1');
    expect(xml).toContain('_note="A note"');
    expect(xml).toContain('Child 1.2');
    expect(xml).toContain('_complete="true"');
  });

  it('imports OPML in merge mode', async () => {
    const { importOpml } = await import('../src/services/import-service.js');
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    const userId = me.user.id;

    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: tree.root.id, text: 'Existing' },
    });

    importOpml(app.db, userId, sampleOpml, 'merge');

    const tree2 = (await inject({ method: 'GET', url: '/api/tree?includeCompleted=true' })).json();
    expect(tree2.root.children.length).toBeGreaterThanOrEqual(3);
  });

  it('decodes HTML entities in imported OPML', async () => {
    const { importOpml } = await import('../src/services/import-service.js');
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    const userId = me.user.id;

    const opmlWithEntities = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test</title></head>
  <body>
    <outline text="a &lt;b&gt;bold&lt;/b&gt; link: &amp;test" _note="quote: &quot;hello&quot; &amp; &apos;world&apos;"/>
  </body>
</opml>`;

    importOpml(app.db, userId, opmlWithEntities, 'replace');

    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(tree.root.children[0].text).toBe('a <b>bold</b> link: &test');
    expect(tree.root.children[0].description).toBe("quote: \"hello\" & 'world'");
  });
});

describe('TXT import/export', () => {
  const sampleTxt = `- Item 1
  "A note"
  - Child 1.1
  - [COMPLETE] Child 1.2
- Item 2`;

  it('imports TXT in replace mode', async () => {
    const { importTxt } = await import('../src/services/import-txt-service.js');
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    const userId = me.user.id;

    const result = importTxt(app.db, userId, sampleTxt, 'replace');
    expect(result.importedCount).toBe(4);

    const tree = (await inject({ method: 'GET', url: '/api/tree?includeCompleted=true' })).json();
    expect(tree.root.children).toHaveLength(2);
    expect(tree.root.children[0].text).toBe('Item 1');
    expect(tree.root.children[0].description).toBe('A note');
    expect(tree.root.children[0].children).toHaveLength(2);
    expect(tree.root.children[0].children[0].text).toBe('Child 1.1');
    expect(tree.root.children[0].children[1].text).toBe('Child 1.2');
    expect(tree.root.children[0].children[1].status).toBe('completed');
  });

  it('exports TXT round-trip', async () => {
    const { importTxt } = await import('../src/services/import-txt-service.js');
    const { exportTxt } = await import('../src/services/export-txt-service.js');
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    const userId = me.user.id;

    importTxt(app.db, userId, sampleTxt, 'replace');
    const txt = exportTxt(app.db, userId);

    expect(txt).toContain('- Item 1');
    expect(txt).toContain('"A note"');
    expect(txt).toContain('- Child 1.1');
    expect(txt).toContain('[COMPLETE] Child 1.2');
    expect(txt).toContain('- Item 2');
  });

  it('handles multi-line notes', async () => {
    const { importTxt } = await import('../src/services/import-txt-service.js');
    const { exportTxt } = await import('../src/services/export-txt-service.js');
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    const userId = me.user.id;

    const multiLineTxt = `- Task
  "Line one
  Line two
  "`;

    importTxt(app.db, userId, multiLineTxt, 'replace');

    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(tree.root.children[0].text).toBe('Task');
    expect(tree.root.children[0].description).toBe('Line one\nLine two');

    const exported = exportTxt(app.db, userId);
    expect(exported).toContain('"Line one');
    expect(exported).toContain('Line two');
  });

  it('imports TXT in merge mode', async () => {
    const { importTxt } = await import('../src/services/import-txt-service.js');
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
    const userId = me.user.id;

    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: tree.root.id, text: 'Existing' },
    });

    importTxt(app.db, userId, sampleTxt, 'merge');

    const tree2 = (await inject({ method: 'GET', url: '/api/tree?includeCompleted=true' })).json();
    expect(tree2.root.children.length).toBeGreaterThanOrEqual(3);
  });
});

describe('completed nodes filtering', () => {
  it('excludes completed nodes by default', async () => {
    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    const rootId = tree.root.id;

    const node = (await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'Done' },
    })).json();

    await inject({
      method: 'PATCH',
      url: `/api/nodes/${node.id}`,
      payload: { status: 'completed' },
    });

    const withoutCompleted = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(withoutCompleted.root.children).toHaveLength(0);

    const withCompleted = (await inject({ method: 'GET', url: '/api/tree?includeCompleted=true' })).json();
    expect(withCompleted.root.children).toHaveLength(1);
  });
});

describe('POST /api/nodes/:id/split', () => {
  it('splits a node in the middle, children go to second half', async () => {
    const tree = (await inject({ method: 'GET', url: '/api/tree' })).json();
    const rootId = tree.root.id;

    const parent = (await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: rootId, text: 'Hello World' },
    })).json();

    await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: parent.id, text: 'Child node' },
    });

    const res = await inject({
      method: 'POST',
      url: `/api/nodes/${parent.id}/split`,
      payload: { textBefore: 'Hello', textAfter: ' World' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.original.text).toBe('Hello');
    expect(body.created.text).toBe(' World');

    const tree2 = (await inject({ method: 'GET', url: '/api/tree' })).json();
    expect(tree2.root.children).toHaveLength(2);
    expect(tree2.root.children[0].text).toBe('Hello');
    expect(tree2.root.children[0].children).toHaveLength(0);
    expect(tree2.root.children[1].text).toBe(' World');
    expect(tree2.root.children[1].children).toHaveLength(1);
    expect(tree2.root.children[1].children[0].text).toBe('Child node');
  });
});

describe('Multi-tenancy isolation', () => {
  it('users cannot see each other\'s nodes', async () => {
    // Create a node as user 1
    const tree1 = (await inject({ method: 'GET', url: '/api/tree' })).json();
    await inject({
      method: 'POST',
      url: '/api/nodes',
      payload: { parentId: tree1.root.id, text: 'User 1 secret' },
    });

    // Register user 2 (allowed because user 1 is authenticated)
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'user2', password: 'testpass123' },
      headers: { cookie },
    });
    expect(res2.statusCode).toBe(200);
    const setCookie2 = res2.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie2) ? setCookie2[0] : setCookie2;
    const cookie2 = (cookieStr as string).split(';')[0];

    // User 2 should see empty tree
    const tree2 = (await app.inject({
      method: 'GET',
      url: '/api/tree',
      headers: { cookie: cookie2 },
    })).json();
    expect(tree2.root.children).toHaveLength(0);
    expect(tree2.root.text).toBe('My Outline');

    // User 2's search should not find user 1's nodes
    const search = (await app.inject({
      method: 'GET',
      url: '/api/search?q=secret',
      headers: { cookie: cookie2 },
    })).json();
    expect(search.results).toHaveLength(0);
  });
});
