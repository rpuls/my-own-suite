import assert from 'node:assert/strict';
import test from 'node:test';
import devWorker from '../../infrastructure/installer-endpoint/dev/worker.mjs';
import stableWorker from '../../infrastructure/installer-endpoint/stable/worker.mjs';
import { createInstallerWorker, renderInstaller, resolveInstallRef, resolveLatestStableRef } from '../../infrastructure/installer-endpoint/core.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const releaseCommit = 'fedcba9876543210fedcba9876543210fedcba98';

function installerRequest() {
  return new Request('https://get-dev.myownsuite.org/install.sh');
}

function githubStub({ tagName = 'v0.16.0', releaseStatus = 200, commitStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/releases/latest')) {
      return releaseStatus === 200
        ? Response.json({ tag_name: tagName })
        : new Response('nope', { status: releaseStatus });
    }
    return commitStatus === 200
      ? Response.json({ sha: String(url).includes('/commits/v') ? releaseCommit : commit })
      : new Response('nope', { status: commitStatus });
  };
  return { calls, fetchImpl };
}

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
  assert.deepEqual(await resolveInstallRef('main', fakeFetch), { label: 'main', ref: commit });
  assert.deepEqual(await resolveInstallRef('feat/app-platform-lab', fakeFetch), {
    label: 'feat/app-platform-lab', ref: commit,
  });
  assert.match(requests[1].url, /feat\/app-platform-lab$/);
  assert.equal(requests[0].options.headers['User-Agent'], 'my-own-suite-installer');
});

test('production installs the published release, not the tip of main', async () => {
  const stub = githubStub();
  const resolved = await resolveLatestStableRef(stub.fetchImpl);

  assert.deepEqual(resolved, { label: 'v0.16.0', ref: releaseCommit });
  assert.equal(stub.calls.length, 2);
  assert.match(stub.calls[0], /\/releases\/latest$/);
  assert.match(stub.calls[1], /\/commits\/v0\.16\.0$/);
  assert.doesNotMatch(stub.calls.join(' '), /commits\/main/u);
});

test('production refuses a release that is not tagged vX.Y.Z', async () => {
  await assert.rejects(
    resolveLatestStableRef(githubStub({ tagName: 'nightly-2026-08-07' }).fetchImpl),
    /not tagged vX\.Y\.Z/u,
  );
});

test('stable and development endpoints resolve different things', async () => {
  const stableStub = githubStub();
  const stable = createInstallerWorker(() => ({ stable: true }), { fetchImpl: stableStub.fetchImpl });
  const stableResponse = await stable.fetch(installerRequest(), {});
  assert.equal(stableResponse.headers.get('x-mos-install-source'), 'v0.16.0');
  assert.equal(stableResponse.headers.get('x-mos-install-ref'), releaseCommit);

  const devStub = githubStub();
  const dev = createInstallerWorker(() => ({ branch: 'staging' }), { fetchImpl: devStub.fetchImpl });
  const devResponse = await dev.fetch(installerRequest(), {});
  assert.equal(devResponse.headers.get('x-mos-install-source'), 'staging');
  assert.equal(devResponse.headers.get('x-mos-install-ref'), commit);
  assert.doesNotMatch(devStub.calls.join(' '), /releases\/latest/u);
});

test('the deployed workers are wired to their own channel', async () => {
  const stableStub = githubStub();
  globalThis.fetch = stableStub.fetchImpl;
  try {
    assert.equal((await stableWorker.fetch(installerRequest(), {})).headers.get('x-mos-install-source'), 'v0.16.0');
    const dev = await devWorker.fetch(installerRequest(), { INSTALL_BRANCH: 'staging' });
    assert.equal(dev.headers.get('x-mos-install-source'), 'staging');
  } finally {
    delete globalThis.fetch;
  }
});

test('endpoint serves an exact commit resolved from its configured branch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ sha: commit });
  try {
    const response = await devWorker.fetch(new Request('https://get-dev.myownsuite.org/install.sh'), {
      INSTALL_BRANCH: 'feat/app-platform-lab',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-mos-install-source'), 'feat/app-platform-lab');
    assert.equal(response.headers.get('x-mos-install-ref'), commit);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('endpoint stops asking GitHub for a ref it already knows', async () => {
  let calls = 0;
  const endpoint = createInstallerWorker(() => ({ branch: 'staging' }), {
    fetchImpl: async () => { calls += 1; return Response.json({ sha: commit }); },
    now: () => 1_000,
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await endpoint.fetch(installerRequest(), {})).status, 200);
  }
  assert.equal(calls, 1);
});

test('endpoint serves the last known commit while GitHub refuses to answer', async () => {
  let clock = 0;
  let rateLimited = false;
  const endpoint = createInstallerWorker(() => ({ branch: 'staging' }), {
    fetchImpl: async () => (rateLimited
      ? new Response('rate limit exceeded', { status: 403 })
      : Response.json({ sha: commit })),
    now: () => clock,
  });

  assert.equal((await endpoint.fetch(installerRequest(), {})).status, 200);

  rateLimited = true;
  clock = 10 * 60_000;
  const fallback = await endpoint.fetch(installerRequest(), {});
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get('x-mos-install-ref'), commit);
  assert.equal(fallback.headers.get('x-mos-install-ref-age'), '600');

  clock = 25 * 60 * 60 * 1000;
  assert.equal((await endpoint.fetch(installerRequest(), {})).status, 503);
});

test('endpoint fails closed when GitHub cannot resolve the branch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  try {
    assert.equal((await devWorker.fetch(new Request('https://get.myownsuite.org/'), {})).status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
