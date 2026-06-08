#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const action = process.argv[2];
const args = process.argv.slice(3);
const simulateSelfHost =
  args.includes('--simulateSelfHost') ||
  args.includes('--simulate-selfhost') ||
  process.env.npm_config_simulateselfhost === 'true' ||
  process.env.npm_config_simulate_selfhost === 'true';

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

const profiles = [
  '--profile',
  'vaultwarden',
  '--profile',
  'seafile',
  '--profile',
  'onlyoffice',
  '--profile',
  'stirling-pdf',
  '--profile',
  'radicale',
  '--profile',
  'immich',
];

run('npm', ['run', 'vps:init']);
run('npm', ['run', 'vps:doctor']);

if (action === 'rebuild') {
  run('node', [
    'scripts/mos-compose.cjs',
    ...profiles,
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  run('node', [
    'scripts/mos-compose.cjs',
    ...profiles,
    'up',
    '-d',
    '--build',
    '--force-recreate',
  ]);
} else if (action === 'up') {
  run('node', ['scripts/mos-compose.cjs', ...profiles, 'up', '-d', '--build']);
} else {
  console.error('Usage: node scripts/vps-run.cjs <up|rebuild> [--simulateSelfHost]');
  process.exit(1);
}
