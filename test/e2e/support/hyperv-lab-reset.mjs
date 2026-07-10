async function requestJson(request, path, options = {}) {
  const response = await request.fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok()) {
    const error = new Error(body.error || `${options.method || 'GET'} ${path} failed with ${response.status()}`);
    error.status = response.status();
    error.body = body;
    throw error;
  }
  return body;
}

export async function resetLabIfConfigured(page, env) {
  if (!env.enableLabReset) return;

  const resetStartedAt = Date.now();
  try {
    await requestJson(page.request, '/suite-manager/api/lab/reset', {
      data: { reason: 'hyperv-e2e' },
      method: 'POST',
    });
  } catch (error) {
    if (error.status === 404 || error.message === 'LAB_RESET_DISABLED') {
      throw new Error(
        'Lab reset endpoint is not available on the Hyper-V VM. Run one fresh Hyper-V reset/update with the current branch so mos-v2-lab-reset-agent is installed, or set MOS_V2_E2E_RESET_BEFORE_RUN=0 to skip automatic reset.'
      );
    }
    throw error;
  }

  const deadline = Date.now() + 3 * 60 * 1000;
  let lastError = null;
  let consecutiveReady = 0;
  while (Date.now() < deadline) {
    try {
      const status = await requestJson(page.request, '/suite-manager/api/setup/status');
      if (status.status === 'needs-owner') {
        consecutiveReady += 1;
        if (consecutiveReady >= 3 && Date.now() - resetStartedAt >= 10_000) return;
      } else {
        consecutiveReady = 0;
      }
    } catch (error) {
      lastError = error;
      consecutiveReady = 0;
    }
    await page.waitForTimeout(3000);
  }

  throw new Error(`Lab reset did not return to first-run setup within 3 minutes.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}
