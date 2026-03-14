import type { MiddlewareHandler } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import { readSession } from './session.ts';

export function requireApiSession(config: SuiteManagerConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!readSession(c, config)) {
      return c.json({ error: 'Authentication required.' }, 401);
    }

    await next();
  };
}

export function hasSession(config: SuiteManagerConfig, c: Parameters<MiddlewareHandler>[0]): boolean {
  return readSession(c, config) !== null;
}

