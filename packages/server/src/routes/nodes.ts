import type { FastifyInstance } from 'fastify';
import { createNode, updateNode, deleteNode, moveNode, splitNode } from '../services/node-service.js';
import { NotFoundError } from '../services/tree-service.js';

export async function nodeRoutes(app: FastifyInstance) {
  app.post('/api/nodes', {
    schema: {
      body: {
        type: 'object',
        required: ['parentId', 'text'],
        properties: {
          id: { type: 'string' },
          parentId: { type: 'string' },
          text: { type: 'string', maxLength: 100000 },
          description: { type: ['string', 'null'], maxLength: 100000 },
          position: { type: 'string' },
          afterId: { type: 'string' },
          beforeId: { type: 'string' },
        },
      },
    },
  }, (request, reply) => {
    try {
      const node = createNode(app.db, request.user!.id, request.body as any);
      reply.code(201);
      return node;
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.patch('/api/nodes/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 100000 },
          description: { type: ['string', 'null'], maxLength: 100000 },
          parentId: { type: 'string' },
          position: { type: 'string' },
          afterId: { type: 'string' },
          beforeId: { type: 'string' },
          status: { type: 'string', enum: ['active', 'completed'] },
        },
      },
    },
  }, (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return updateNode(app.db, request.user!.id, id, request.body as any);
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.delete('/api/nodes/:id', (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return deleteNode(app.db, request.user!.id, id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.post('/api/nodes/:id/move', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['direction'],
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'indent', 'outdent'] },
        },
      },
    },
  }, (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { direction } = request.body as { direction: 'up' | 'down' | 'indent' | 'outdent' };
      return moveNode(app.db, request.user!.id, id, direction);
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof Error && (err.message.includes('Already') || err.message.includes('Cannot') || err.message.includes('No previous'))) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.post('/api/nodes/:id/split', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['textBefore', 'textAfter'],
        properties: {
          textBefore: { type: 'string', maxLength: 100000 },
          textAfter: { type: 'string', maxLength: 100000 },
          newId: { type: 'string' },
        },
      },
    },
  }, (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { textBefore, textAfter, newId } = request.body as { textBefore: string; textAfter: string; newId?: string };
      return splitNode(app.db, request.user!.id, id, textBefore, textAfter, newId);
    } catch (err) {
      if (err instanceof NotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }
  });
}
