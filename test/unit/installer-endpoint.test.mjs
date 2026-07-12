import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { renderInstaller } from '../../infrastructure/installer-endpoint/worker.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';

test('installer pins source and delegates to the shared renderer', () => {
  const script = renderInstaller({ INSTALL_REF: commit });
  assert.match(script, /Ubuntu 24\.04/);
  assert.match(script, /render-bootstrap\.cjs.*--target shell/);
  assert.throws(() => renderInstaller({ INSTALL_REF: 'main' }), /full 40-character/);
});

test('endpoint fails closed without a pinned commit', async () => {
  assert.equal((await worker.fetch(new Request('https://get.myownsuite.org/'), {})).status, 503);
  const response = await worker.fetch(new Request('https://get.myownsuite.org/install.sh'), { INSTALL_REF: commit });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-mos-install-ref'), commit);
});
