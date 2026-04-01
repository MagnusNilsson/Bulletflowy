import type { FastifyInstance } from 'fastify';
import {
  createUser,
  verifyPassword,
  createSession,
  deleteSession,
  hasAnyUsers,
  getUserById,
} from '../services/auth-service.js';
import {
  getRegistrationOptions,
  verifyRegistration,
  getAuthenticationOptions,
  verifyAuthentication,
} from '../services/passkey-service.js';
import { COOKIE_NAME } from '../middleware/auth.js';

function cookieOptions(expiresAt: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    expires: expiresAt,
  };
}

export async function authRoutes(app: FastifyInstance) {
  // Check auth state
  app.get('/api/auth/me', async (request) => {
    const setupRequired = !hasAnyUsers(app.db);
    if (request.user) {
      const user = getUserById(app.db, request.user.id);
      return { user, setupRequired };
    }
    return { user: null, setupRequired };
  });

  const authRateLimit = {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  };

  // Register
  app.post('/api/auth/register', authRateLimit, async (request, reply) => {
    const { username, password } = request.body as { username: string; password: string };

    if (!username || !password) {
      reply.code(400).send({ error: 'Username and password are required' });
      return;
    }

    if (password.length < 8) {
      reply.code(400).send({ error: 'Password must be at least 8 characters' });
      return;
    }

    if (password.length > 128) {
      reply.code(400).send({ error: 'Password must be at most 128 characters' });
      return;
    }

    // Only allow registration if no users exist (setup) or user is authenticated
    if (hasAnyUsers(app.db) && !request.user) {
      reply.code(403).send({ error: 'Registration is closed' });
      return;
    }

    try {
      const user = await createUser(app.db, username, password);
      const { sessionId, expiresAt } = createSession(app.db, user.id);
      reply.setCookie(COOKIE_NAME, sessionId, cookieOptions(expiresAt));
      return { user };
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        reply.code(409).send({ error: 'Username already taken' });
        return;
      }
      throw err;
    }
  });

  // Login with password
  app.post('/api/auth/login', authRateLimit, async (request, reply) => {
    const { username, password } = request.body as { username: string; password: string };

    if (!username || !password) {
      reply.code(400).send({ error: 'Username and password are required' });
      return;
    }

    if (password.length > 128) {
      reply.code(400).send({ error: 'Invalid credentials' });
      return;
    }

    const user = await verifyPassword(app.db, username, password);
    if (!user) {
      reply.code(401).send({ error: 'Invalid credentials' });
      return;
    }

    const { sessionId, expiresAt } = createSession(app.db, user.id);
    reply.setCookie(COOKIE_NAME, sessionId, cookieOptions(expiresAt));
    return { user };
  });

  // Logout
  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[COOKIE_NAME];
    if (sessionId) {
      deleteSession(app.db, sessionId);
      reply.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax' as const });
    }
    return { ok: true };
  });

  // Passkey registration (requires auth)
  app.post('/api/auth/passkey/register-options', async (request, reply) => {
    if (!request.user) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }
    return getRegistrationOptions(app.db, request.user.id, request.user.username);
  });

  app.post('/api/auth/passkey/register-verify', async (request, reply) => {
    if (!request.user) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }
    return verifyRegistration(app.db, request.user.id, request.body as any);
  });

  // Passkey authentication (no auth required)
  app.post('/api/auth/passkey/login-options', authRateLimit, async () => {
    return getAuthenticationOptions(app.db);
  });

  app.post('/api/auth/passkey/login-verify', authRateLimit, async (request, reply) => {
    const result = await verifyAuthentication(app.db, request.body as any);
    const user = getUserById(app.db, result.userId);
    if (!user) {
      reply.code(401).send({ error: 'User not found' });
      return;
    }
    const { sessionId, expiresAt } = createSession(app.db, user.id);
    reply.setCookie(COOKIE_NAME, sessionId, cookieOptions(expiresAt));
    return { user };
  });
}
