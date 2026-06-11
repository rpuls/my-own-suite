#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const action = process.argv[2];
const args = process.argv.slice(3);
const repoRoot = process.cwd();
const defaultCatalogSelectionPath = path.join(repoRoot, 'deploy', 'vps', 'generated', 'app-catalog', 'compose-selection.json');
const catalogSelectionPath = process.env.MOS_APP_CATALOG_SELECTION_PATH || defaultCatalogSelectionPath;
const forceAllProfiles = args.includes('--allProfiles') || args.includes('--all-profiles');
const controlPlaneOnly =
  args.includes('--controlPlaneOnly') ||
  args.includes('--control-plane-only') ||
  process.env.MOS_CONTROL_PLANE_ONLY === '1';
const simulateSelfHost =
  args.includes('--simulateSelfHost') ||
  args.includes('--simulate-selfhost') ||
  process.env.npm_config_simulateselfhost === 'true' ||
  process.env.npm_config_simulate_selfhost === 'true';
const passthroughArgs = args.filter(
  (arg) =>
    arg !== '--simulateSelfHost' &&
    arg !== '--simulate-selfhost' &&
    arg !== '--allProfiles' &&
    arg !== '--all-profiles' &&
    arg !== '--controlPlaneOnly' &&
    arg !== '--control-plane-only',
);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    env: {
      ...process.env,
      ...(simulateSelfHost ? { MOS_SIMULATE_SELFHOST: '1' } : {}),
    },
    shell: process.platform === 'win32',
    stdio: 'inherit',
    ...options,
  });

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (typeof result.status !== 'number') {
    process.exit(1);
  }
}

const defaultProfiles = ['vaultwarden', 'seafile', 'onlyoffice', 'stirling-pdf', 'radicale', 'immich'];

function readSelectedProfiles() {
  if (controlPlaneOnly) {
    return [];
  }

  if (forceAllProfiles || !fs.existsSync(catalogSelectionPath)) {
    return defaultProfiles;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(catalogSelectionPath, 'utf8'));
    if (!Array.isArray(parsed.profiles) || parsed.profiles.some((profile) => typeof profile !== 'string')) {
      throw new Error('profiles must be an array of strings.');
    }
    return Array.from(new Set(parsed.profiles)).sort();
  } catch (error) {
    console.error(
      `Unable to read app catalog Compose selection at ${catalogSelectionPath}: ${
        error instanceof Error ? error.message : 'invalid file'
      }`,
    );
    process.exit(1);
  }
}

function profileArgs(profiles) {
  return profiles.flatMap((profile) => ['--profile', profile]);
}

const selectedProfiles = readSelectedProfiles();
const profiles = profileArgs(selectedProfiles);

if (controlPlaneOnly) {
  console.log('Using control-plane-only profile set.');
} else if (forceAllProfiles) {
  console.log(`Using all app profiles: ${defaultProfiles.join(', ')}`);
} else if (fs.existsSync(catalogSelectionPath)) {
  console.log(
    selectedProfiles.length > 0
      ? `Using app catalog profiles: ${selectedProfiles.join(', ')}`
      : 'Using app catalog selection with no optional app profiles.',
  );
} else {
  console.log(`No app catalog selection found; using existing all-app profile set: ${defaultProfiles.join(', ')}`);
}

run('npm', ['run', 'vps:init']);
run('npm', ['run', 'vps:doctor']);

if (action === 'rebuild') {
  run('node', [
    'scripts/mos-compose.cjs',
    ...profiles,
    ...passthroughArgs,
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  run('node', [
    'scripts/mos-compose.cjs',
    ...profiles,
    ...passthroughArgs,
    'up',
    '-d',
    '--build',
    '--force-recreate',
  ]);
} else if (action === 'up') {
  run('node', ['scripts/mos-compose.cjs', ...profiles, ...passthroughArgs, 'up', '-d', '--build']);
} else {
  console.error('Usage: node scripts/vps-run.cjs <up|rebuild> [--simulateSelfHost] [--allProfiles] [--controlPlaneOnly]');
  process.exit(1);
}
