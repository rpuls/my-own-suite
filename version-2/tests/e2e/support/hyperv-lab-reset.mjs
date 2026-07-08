async function requestJson(request, path, options = {}) {
  const response = await request.fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok()) {
    throw new Error(body.error || `${options.method || 'GET'} ${path} failed with ${response.status()}`);
  }
  return body;
}

export async function resetLabIfConfigured(page, env) {
  if (!env.enableLabReset) return;

  await requestJson(page.request, '/suite-manager/api/lab/reset', {
    data: { reason: 'hyperv-e2e' },
    method: 'POST',
  });

  const deadline = Date.now() + 3 * 60 * 1000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const status = await requestJson(page.request, '/suite-manager/api/setup/status');
      if (status.status === 'needs-owner') return;
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(3000);
  }

  throw new Error(`Lab reset did not return to first-run setup within 3 minutes.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}
