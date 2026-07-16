const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');

// The privacy posture presentation model intentionally exists twice — Suite
// Manager (React) and the public site (Astro) have no shared component
// library yet — and the two copies must stay byte-identical (see the header
// comment in either file). This test turns that comment into CI. The sibling
// PrivacyPosture.tsx/.astro components and their CSS are visual mirrors, not
// byte mirrors (each side carries host-specific rules), so they stay
// comment-enforced.
test('privacy posture twin modules are byte-identical', () => {
  const [suiteManagerCopy, siteCopy] = [
    'suite-manager/frontend/src/features/apps/privacy-posture.ts',
    'site/src/lib/privacy-posture.ts',
  ].map((relative) => fs.readFileSync(path.join(repoRoot, relative)));
  assert.ok(
    suiteManagerCopy.equals(siteCopy),
    'The privacy-posture.ts twins have drifted. Apply the intended change to both copies (they must stay byte-identical).',
  );
});
