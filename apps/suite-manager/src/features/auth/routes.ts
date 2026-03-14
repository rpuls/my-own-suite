import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import { AuthService } from './service.ts';
import { clearSessionCookie, readSession, setSessionCookie } from './session.ts';

export function createAuthRouter(config: SuiteManagerConfig, authService: AuthService): Hono {
  const router = new Hono();

  router.get('/session', (c) => {
    const session = readSession(c, config);
    return c.json({
      authenticated: session !== null,
      owner: session
        ? {
            email: config.ownerEmail,
            name: config.ownerName,
          }
        : null,
    });
  });

  router.post('/login', async (c) => {
    const body = await c.req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!authService.authenticate(email, password)) {
      clearSessionCookie(c, config);
      return c.json({ error: 'Invalid email or password.' }, 401);
    }

    setSessionCookie(c, config);
    return c.json({
      authenticated: true,
      owner: {
        email: config.ownerEmail,
        name: config.ownerName,
      },
    });
  });

  router.post('/logout', (c) => {
    clearSessionCookie(c, config);
    return c.json({ ok: true });
  });

  return router;
}

