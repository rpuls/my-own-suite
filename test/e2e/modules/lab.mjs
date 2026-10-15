async function requestJson(request, url, options = {}) {
  const response = await request.fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok()) {
    const error = new Error(body.error || `${options.method || 'GET'} ${url} failed with ${response.status()}`);
    error.status = response.status();
    throw error;
  }
  return body;
}

// Lab reset goes through the plain address on purpose: it drops the domain, so
// the https door this run may be on stops answering halfway through.
export async function reset(ctx) {
  const { page, env } = ctx;
  const url = (pathname) => new URL(pathname, `${env.baseURL}/`).toString();
  let started;
  try {
    started = await requestJson(page.request, url('/suite-manager/api/lab/reset'), { data: { reason: 'e2e' }, method: 'POST' });
  } catch (error) {
    if (error.status === 404 || error.message === 'LAB_RESET_DISABLED') {
      throw new Error('The lab reset endpoint is not available on this machine. Reinstall the lab (npm run smoke:hyperv:reset) so mos-lab-reset-agent is installed.');
    }
    throw error;
  }
  if (!started?.resetId) throw new Error('The lab reset endpoint returned no resetId.');

  const deadline = Date.now() + 4 * 60 * 1000;
  let lastError = null;
  let lastJob = null;
  while (Date.now() < deadline) {
    try {
      lastJob = await requestJson(page.request, url(`/suite-manager/api/lab/reset/${encodeURIComponent(started.resetId)}`));
      if (lastJob.status === 'failed') throw new Error(lastJob.error || 'Lab reset worker failed.');
      if (lastJob.status === 'completed') {
        const status = await requestJson(page.request, url('/suite-manager/api/setup/status'));
        if (status.status === 'needs-owner') {
          ctx.homeUrl = env.baseURL;
          ctx.homepageCheckpoint = null;
          return;
        }
        lastError = new Error(`Lab reset completed, but setup status is ${status.status}.`);
      }
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(3000);
  }
  throw new Error(`Lab reset ${started.resetId} did not return to first-run setup within 4 minutes. Last job status: ${lastJob?.status || 'unavailable'}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}
