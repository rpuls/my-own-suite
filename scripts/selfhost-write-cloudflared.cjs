#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function readArg(name) {
  const prefixed = `--${name}=`;
  const valueWithEquals = process.argv.find((arg) => arg.startsWith(prefixed));
  if (valueWithEquals) {
    return valueWithEquals.slice(prefixed.length).trim();
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1].trim();
  }

  return '';
}

const domain = readArg('domain');
const tunnelId = readArg('tunnel-id');
const localTarget = readArg('local-target') || 'http://caddy:80';
const outputArg = readArg('output');
const outputPath = outputArg
  ? path.resolve(process.cwd(), outputArg)
  : path.resolve(process.cwd(), 'deploy', 'self-host', 'cloudflared.generated.yml');

if (!domain) {
  console.error('Missing required --domain argument. Example: --domain example.com');
  process.exit(1);
}

if (!tunnelId) {
  console.error('Missing required --tunnel-id argument. Example: --tunnel-id 00000000-0000-0000-0000-000000000000');
  process.exit(1);
}

const hostPattern = `*.mos.${domain}`;
const config = `tunnel: ${tunnelId}
credentials-file: /etc/cloudflared/${tunnelId}.json

ingress:
  - hostname: ${hostPattern}
    service: ${localTarget}
  - service: http_status:404
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, config, 'utf8');

console.log(`Wrote ${outputPath}`);
console.log(`Wildcard hostname: ${hostPattern}`);
console.log(`Local upstream: ${localTarget}`);
