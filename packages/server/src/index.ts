import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { createDatabase } from './db.js';
import { cleanExpiredSessions } from './services/auth-service.js';
import { authMiddleware } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { treeRoutes } from './routes/tree.js';
import { nodeRoutes } from './routes/nodes.js';
import { importRoutes } from './routes/import.js';
import { searchRoutes } from './routes/search.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database.Database;
  }
  interface FastifyRequest {
    user?: { id: string; username: string };
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(dbPath?: string) {
  const app = Fastify({ logger: true });

  const db = createDatabase(dbPath);
  app.decorate('db', db);

  // Clean expired sessions on startup and every hour
  cleanExpiredSessions(db);
  const sessionCleanupInterval = setInterval(() => cleanExpiredSessions(db), 60 * 60 * 1000);

  app.addHook('onClose', () => {
    clearInterval(sessionCleanupInterval);
    db.close();
  });

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: false, // only apply where explicitly configured
  });
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Auth middleware — runs on all /api/* routes, skips public auth endpoints
  app.addHook('preHandler', authMiddleware);

  // Error handler
  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _request, reply) => {
    app.log.error(error);
    const status = error.statusCode ?? 500;
    reply.code(status).send({
      error: status === 500 ? 'Internal server error' : error.message,
      ...(status !== 500 && error.validation ? { details: error.validation } : {}),
    });
  });

  // Register routes
  await app.register(authRoutes);
  await app.register(treeRoutes);
  await app.register(nodeRoutes);
  await app.register(importRoutes);
  await app.register(searchRoutes);

  // In production, serve the built client
  const clientDist = path.resolve(__dirname, '../../client/dist');
  try {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback: serve index.html for non-API routes
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'Not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  } catch {
    // Client not built yet — dev mode
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'Not found' });
      } else {
        reply.code(404).send({ error: 'Client not built. Run npm run build -w packages/client' });
      }
    });
  }

  return app;
}

// Start server when run directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/index.ts') ||
  process.argv[1].endsWith('/index.js')
);

if (isMain) {
  const app = await buildApp();
  const port = parseInt(process.env.PORT ?? '3001', 10);
  await app.listen({ port, host: '127.0.0.1' });
}
