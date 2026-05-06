import type { FastifyRequest, FastifyReply } from 'fastify';
import { getSession, getUserById } from '../services/auth-service.js';

const PUBLIC_ROUTES = new Set([
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/me',
  '/api/auth/passkey/login-options',
  '/api/auth/passkey/login-verify',
]);

export const COOKIE_NAME = 'bulletflowy_session';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // Skip non-API routes
  if (!request.url.startsWith('/api/')) return;

  const path = request.url.split('?')[0];
  const isPublic = PUBLIC_ROUTES.has(path);

  // Try to resolve user from cookie
  const sessionId = request.cookies[COOKIE_NAME];
  if (sessionId) {
    const session = getSession(request.server.db, sessionId);
    if (session) {
      const user = getUserById(request.server.db, session.userId);
      if (user) {
        request.user = { id: user.id, username: user.username };
        return;
      }
    }
    // Invalid session — always clear cookie so a stale cookie doesn't
    // linger on public routes and cause 401 loops on subsequent calls.
    reply.clearCookie(COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
    });
    if (!isPublic) {
      reply.code(401).send({ error: 'Session expired' });
      return;
    }
  }

  // No valid session — reject protected routes
  if (!isPublic) {
    reply.code(401).send({ error: 'Not authenticated' });
    return;
  }
}
