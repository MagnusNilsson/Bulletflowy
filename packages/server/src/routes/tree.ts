import type { FastifyInstance } from 'fastify';
import { getTree } from '../services/tree-service.js';

export async function treeRoutes(app: FastifyInstance) {
  app.get('/api/tree', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          includeCompleted: { type: 'string' },
        },
      },
    },
  }, (request) => {
    const query = request.query as { includeCompleted?: string };
    const includeCompleted = query.includeCompleted === 'true';
    return getTree(app.db, request.user!.id, includeCompleted);
  });
}
