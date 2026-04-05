import type { FastifyInstance } from 'fastify';
import { searchNodes } from '../services/search-service.js';

export async function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', {
    schema: {
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string' },
          includeCompleted: { type: 'string', default: 'false' },
        },
      },
    },
  }, (request) => {
    const { q, includeCompleted } = request.query as { q: string; includeCompleted?: string };
    return { results: searchNodes(app.db, request.user!.id, q, includeCompleted === 'true') };
  });
}
