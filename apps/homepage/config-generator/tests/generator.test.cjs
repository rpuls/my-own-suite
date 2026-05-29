const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse } = require('yaml');

const generatorPath = path.resolve(__dirname, '..', 'dist', 'index.js');

function runGenerator(template, env = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homepage-config-'));
  fs.writeFileSync(path.join(configDir, 'services.template.yaml'), template);

  execFileSync(process.execPath, [generatorPath, configDir], {
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'pipe',
  });

  const output = fs.readFileSync(path.join(configDir, 'services.yaml'), 'utf8');
  fs.rmSync(configDir, { recursive: true, force: true });
  return parse(output);
}

test('replaces resolved placeholders in service leaves', () => {
  const output = runGenerator(
    `
- My Own Suite:
    - Management:
        - Suite Manager:
            href: \${SUITE_MANAGER_URL}/setup/
            description: Control plane
`,
    { SUITE_MANAGER_URL: 'http://suite-manager.localhost' },
  );

  assert.deepEqual(output, [
    {
      'My Own Suite': [
        {
          Management: [
            {
              'Suite Manager': {
                href: 'http://suite-manager.localhost/setup/',
                description: 'Control plane',
              },
            },
          ],
        },
      ],
    },
  ]);
});

test('removes unresolved service tiles and empty parent groups', () => {
  const output = runGenerator(
    `
- My Own Suite:
    - My Files:
        - Seafile:
            href: \${SEAFILE_URL}
            description: Files
    - My Tools:
        - Stirling PDF:
            href: \${STIRLING_PDF_URL}
            description: PDF tools
`,
    { STIRLING_PDF_URL: 'http://stirling-pdf.localhost' },
  );

  assert.deepEqual(output, [
    {
      'My Own Suite': [
        {
          'My Tools': [
            {
              'Stirling PDF': {
                href: 'http://stirling-pdf.localhost',
                description: 'PDF tools',
              },
            },
          ],
        },
      ],
    },
  ]);
});

test('keeps recursive nested Homepage groups when children resolve', () => {
  const output = runGenerator(
    `
- Top:
    - Middle:
        - Inner:
            - Resolved:
                href: \${RESOLVED_URL}
                description: Kept
            - Missing:
                href: \${MISSING_URL}
                description: Removed
`,
    { RESOLVED_URL: 'https://example.com' },
  );

  assert.deepEqual(output, [
    {
      Top: [
        {
          Middle: [
            {
              Inner: [
                {
                  Resolved: {
                    href: 'https://example.com',
                    description: 'Kept',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
});

test('fetches allow-listed runtime config files before generation', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homepage-config-fetch-'));
  const configUrl = `data:application/json,${encodeURIComponent(
    JSON.stringify({
        files: [
          {
            name: 'services.template.yaml',
            content: `
- Remote:
    - Link:
        href: https://example.org
        description: Fetched
`,
          },
          {
            name: '../ignored.yaml',
            content: 'bad: true',
          },
        ],
      }),
  )}`;

  try {
    execFileSync(process.execPath, [generatorPath, '--fetch-config', configUrl, configDir], {
      env: {
        ...process.env,
        HOMEPAGE_CONFIG_SYNC_TOKEN: 'test-token',
      },
      stdio: 'pipe',
    });

    assert.match(fs.readFileSync(path.join(configDir, 'services.template.yaml'), 'utf8'), /Fetched/);
    assert.equal(fs.existsSync(path.join(configDir, '..', 'ignored.yaml')), false);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
