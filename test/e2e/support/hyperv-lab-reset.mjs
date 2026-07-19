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
  let reset;

  try {
    reset = await requestJson(page.request, '/suite-manager/api/lab/reset', {
      data: { reason: 'hyperv-e2e' },
      method: 'POST',
    });
  } catch (error) {
    if (error.status === 404 || error.message === 'LAB_RESET_DISABLED') {
      throw new Error(
        'Lab reset endpoint is not available on the Hyper-V VM. Run one fresh Hyper-V reset/update with the current branch so mos-lab-reset-agent is installed, or set MOS_E2E_RESET_BEFORE_RUN=0 to skip automatic reset.'
      );
    }
    throw error;
  }
  if (!reset?.resetId) {
    throw new Error('Lab reset endpoint did not return a resetId. Run one fresh Hyper-V reset/update with the current branch so the observable lab reset agent is installed.');
  }

  const deadline = Date.now() + 3 * 60 * 1000;
  let lastError = null;
  let lastJob = null;
  while (Date.now() < deadline) {
    try {
      lastJob = await requestJson(page.request, `/suite-manager/api/lab/reset/${encodeURIComponent(reset.resetId)}`);
      if (lastJob.status === 'failed') throw new Error(lastJob.error || 'Lab reset worker failed.');
      if (lastJob.status === 'completed') {
        const status = await requestJson(page.request, '/suite-manager/api/setup/status');
        if (status.status === 'needs-owner') return;
        lastError = new Error(`Lab reset completed, but setup status is ${status.status}.`);
      }
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(3000);
  }

  throw new Error(`Lab reset ${reset.resetId} did not return to first-run setup within 3 minutes. Last job status: ${lastJob?.status || 'unavailable'}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}
