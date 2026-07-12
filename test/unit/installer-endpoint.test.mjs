import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../../infrastructure/installer-endpoint/dev/worker.mjs';
import { renderInstaller, resolveInstallRef } from '../../infrastructure/installer-endpoint/core.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';

test('installer pins source and delegates to the shared renderer', () => {
  const script = renderInstaller(commit);
  assert.match(script, /Ubuntu 24\.04/);
  assert.match(script, /render-bootstrap\.cjs.*--target shell/);
  assert.match(script, /--front-door public-vps/);
  assert.doesNotMatch(script, /--front-door ssh-bootstrap/);
  assert.throws(() => renderInstaller('main'), /full 40-character/);
});

test('branch resolver defaults to main and accepts a configured development branch', async () => {
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ sha: commit });
  };
  assert.deepEqual(await resolveInstallRef('main', fakeFetch), { branch: 'main', ref: commit });
  assert.deepEqual(await resolveInstallRef('feat/app-platform-v2-lab', fakeFetch), {
    branch: 'feat/app-platform-v2-lab', ref: commit,
  });
  assert.match(requests[1].url, /feat\/app-platform-v2-lab$/);
  assert.equal(requests[0].options.headers['User-Agent'], 'my-own-suite-installer');
});

test('endpoint serves an exact commit resolved from its configured branch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ sha: commit });
  try {
    const response = await worker.fetch(new Request('https://get-dev.myownsuite.org/install.sh'), {
      INSTALL_BRANCH: 'feat/app-platform-v2-lab',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-mos-install-branch'), 'feat/app-platform-v2-lab');
    assert.equal(response.headers.get('x-mos-install-ref'), commit);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('endpoint fails closed when GitHub cannot resolve the branch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  try {
    assert.equal((await worker.fetch(new Request('https://get.myownsuite.org/'), {})).status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
