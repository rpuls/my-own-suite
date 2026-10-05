import { expect } from '@playwright/test';

function requestFromPage(page, path, options) {
  return page.evaluate(async ({ requestPath, requestOptions }) => {
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
}

// A GET is repeated when the page navigated under it (Suite Manager reloads its
// own screens around a restore); anything that changes state is never repeated.
export async function apiJson(page, path, options = {}) {
  let result;
  for (let attempt = 0; !result; attempt += 1) {
    try {
      result = await requestFromPage(page, path, options);
    } catch (error) {
      if ((options.method || 'GET') !== 'GET' || attempt >= 3 || !/Execution context was destroyed/u.test(error.message)) throw error;
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
  }

  if (!result.ok) {
    const error = new Error(result.body.error || `${options.method || 'GET'} ${path} failed with ${result.status}`);
    error.status = result.status;
    throw error;
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
