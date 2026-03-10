import type { Context } from 'hono';

export function isAuthorized(c: Context, bootstrapToken: string): boolean {
  if (!bootstrapToken) {
    return true;
  }

  const headerValue = c.req.header('x-bootstrap-token');
  return headerValue === bootstrapToken;
}
