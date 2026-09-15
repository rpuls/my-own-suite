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

test('endpoint fails closed when GitHub cannot resolve the branch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  try {
    assert.equal((await devWorker.fetch(new Request('https://get.myownsuite.org/'), {})).status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The endpoint spent two unauthenticated GitHub calls on every request, and that
// budget belongs to the Worker colo's shared address rather than to MOS. Once it
// ran out, a healthy installer reported itself unavailable and a cloud install
// got nothing, which is how a link check found it.
test('a resolved ref outlives a GitHub rate limit rather than becoming an outage', async () => {
  const stub = githubStub();
  let clock = 0;
  let refusing = false;
  const worker = createInstallerWorker(() => ({ stable: true }), {
    fetchImpl: async (url) => (refusing ? new Response('rate limited', { status: 403 }) : stub.fetchImpl(url)),
    now: () => clock,
  });

  const first = await worker.fetch(installerRequest(), {});
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-mos-install-stale'), null);

  refusing = true;
  clock += 10 * 60 * 1000;
  const second = await worker.fetch(installerRequest(), {});
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-mos-install-ref'), releaseCommit);
  assert.match(second.headers.get('x-mos-install-stale'), /403/u);
});

test('a resolved ref is reused instead of spending GitHub calls on every request', async () => {
  const stub = githubStub();
  const worker = createInstallerWorker(() => ({ stable: true }), { fetchImpl: stub.fetchImpl });

  await worker.fetch(installerRequest(), {});
  await worker.fetch(installerRequest(), {});
  assert.equal(stub.calls.length, 2);
});

// Answering GET alone made every HEAD look like a missing installer, which is
// both what a link checker asks first and what a person reaching for `curl -I`
// sees when they are checking whether the endpoint is up.
test('the endpoint answers HEAD with the same headers and no body', async () => {
  const stub = githubStub();
  const worker = createInstallerWorker(() => ({ stable: true }), { fetchImpl: stub.fetchImpl });

  const response = await worker.fetch(new Request('https://get.myownsuite.org/install.sh', { method: 'HEAD' }), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-mos-install-ref'), releaseCommit);
  assert.equal(response.headers.get('x-mos-install-source'), 'v0.16.0');
  assert.equal(await response.text(), '');
});

test('a method the endpoint does not serve is still refused', async () => {
  const worker = createInstallerWorker(() => ({ stable: true }), { fetchImpl: githubStub().fetchImpl });
  const response = await worker.fetch(new Request('https://get.myownsuite.org/install.sh', { method: 'POST' }), {});
  assert.equal(response.status, 404);
});
