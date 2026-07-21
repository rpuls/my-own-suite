import { expect } from '@playwright/test';

export async function apiJson(page, path, options = {}) {
  const result = await page.evaluate(async ({ requestPath, requestOptions }) => {
    const response = await fetch(requestPath, {
      body: requestOptions.body,
      credentials: 'same-origin',
      headers: requestOptions.headers,
      method: requestOptions.method || 'GET',
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }

    return {
      body,
      ok: response.ok,
      status: response.status,
    };
  }, {
    requestPath: path,
    requestOptions: {
      body: options.body,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      method: options.method,
    },
  });

  if (!result.ok) {
    throw new Error(result.body.error || `${options.method || 'GET'} ${path} failed with ${result.status}`);
  }
  return result.body;
}

export function apiPathFor(entryUrl, pathname) {
  if (!/^https?:\/\//iu.test(entryUrl)) return pathname;
  return new URL(pathname, entryUrl).toString();
}

export async function expectSignedInApi(page, entryUrl = '/') {
  const status = await apiJson(page, apiPathFor(entryUrl, '/suite-manager/api/setup/status'));
  expect(status.status).toBe('signed-in');
  return status;
}
