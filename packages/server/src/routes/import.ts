import type { FastifyInstance } from 'fastify';
import { importOpml } from '../services/import-service.js';
import { exportOpml } from '../services/export-service.js';
import { importTxt } from '../services/import-txt-service.js';
import { exportTxt } from '../services/export-txt-service.js';

export async function importRoutes(app: FastifyInstance) {
  app.post('/api/import/opml', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['replace', 'merge'], default: 'replace' },
        },
      },
    },
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      reply.code(400);
      return { error: 'No file uploaded' };
    }

    const buffer = await data.toBuffer();
    const xmlContent = buffer.toString('utf-8');
    const query = request.query as { mode?: string };
    const mode = (query.mode === 'merge' ? 'merge' : 'replace') as 'replace' | 'merge';

    try {
      const result = importOpml(app.db, request.user!.id, xmlContent, mode);
      return result;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : 'Import failed' };
    }
  });

  app.get('/api/export/opml', (request, reply) => {
    const xml = exportOpml(app.db, request.user!.id);
    reply.type('application/xml').send(xml);
  });

  app.post('/api/import/txt', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['replace', 'merge'], default: 'replace' },
        },
      },
    },
  }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      reply.code(400);
      return { error: 'No file uploaded' };
    }

    const buffer = await data.toBuffer();
    const txtContent = buffer.toString('utf-8');
    const query = request.query as { mode?: string };
    const mode = (query.mode === 'merge' ? 'merge' : 'replace') as 'replace' | 'merge';

    try {
      const result = importTxt(app.db, request.user!.id, txtContent, mode);
      return result;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : 'Import failed' };
    }
  });

  app.get('/api/export/txt', (request, reply) => {
    const txt = exportTxt(app.db, request.user!.id);
    reply.type('text/plain').send(txt);
  });
}
