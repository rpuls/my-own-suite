import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { SuiteManagerConfig } from '../../config.ts';
import type { SessionPayload } from './types.ts';

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createSessionValue(config: SuiteManagerConfig): string {
  const payload: SessionPayload = {
    email: config.ownerEmail,
    exp: Date.now() + config.sessionMaxAgeSeconds * 1000,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signPayload(encodedPayload, config.sessionSecret);
  return `${encodedPayload}.${signature}`;
}

export function readSession(c: Context, config: SuiteManagerConfig): SessionPayload | null {
  const rawCookie = getCookie(c, config.sessionCookieName);
  if (!rawCookie) {
    return null;
  }

  const [encodedPayload, signature] = rawCookie.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signPayload(encodedPayload, config.sessionSecret);
  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SessionPayload;
    if (parsed.email !== config.ownerEmail || parsed.exp <= Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setSessionCookie(c: Context, config: SuiteManagerConfig): void {
  setCookie(c, config.sessionCookieName, createSessionValue(config), {
    httpOnly: true,
    maxAge: config.sessionMaxAgeSeconds,
    path: '/',
    sameSite: 'Lax',
    secure: config.urlScheme === 'https',
  });
}

export function clearSessionCookie(c: Context, config: SuiteManagerConfig): void {
  deleteCookie(c, config.sessionCookieName, {
    path: '/',
  });
}

