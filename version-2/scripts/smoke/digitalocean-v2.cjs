#!/usr/bin/env node

const { renderBootstrapPlan } = require('../installers/bootstrap-contract.cjs');

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function usage() {
  console.log(`Usage: node scripts/smoke/digitalocean-v2.cjs <render>

Commands:
  render   Render the V2 DigitalOcean smoke bootstrap payload without creating paid resources.

Environment:
  MOS_V2_SMOKE_REPO_URL      Repository URL. Defaults to the MOS GitHub repo.
  MOS_V2_SMOKE_REPO_REF      Branch, tag, or SHA. Defaults to feat/app-platform-v2-lab.
  MOS_V2_SMOKE_PUBLIC_IPV4   Optional public IPv4 used to derive <ip>.sslip.io.
  MOS_V2_SMOKE_DOMAIN        Optional explicit smoke domain.
`);
}

function smokeInputFromEnv() {
  return {
    domain: env('MOS_V2_SMOKE_DOMAIN'),
    frontDoor: 'digitalocean-smoke',
    publicIpv4: env('MOS_V2_SMOKE_PUBLIC_IPV4'),
    repoRef: env('MOS_V2_SMOKE_REPO_REF'),
    repoUrl: env('MOS_V2_SMOKE_REPO_URL'),
  };
}

function render() {
  const plan = renderBootstrapPlan(smokeInputFromEnv());
  process.stdout.write(`${JSON.stringify({
    note: 'Render-only V2 DigitalOcean smoke payload. No Droplet was created.',
    repoUrl: plan.config.repoUrl,
    repoRef: plan.config.repoRef,
    domain: plan.config.domain,
    suiteManagerUrl: plan.config.publicUrls.suiteManager,
    homepageUrl: plan.config.publicUrls.homepage,
    components: plan.config.components,
    cloudInit: plan.cloudInit,
  }, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];

  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'render') {
    render();
    return;
  }

  if (command === 'up' || command === 'reset' || command === 'destroy') {
    throw new Error(`"${command}" is not implemented for V2 yet. Use "render" and keep paid DigitalOcean actions user-run.`);
  }

  throw new Error(`Unknown command: ${command}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[mos-v2-smoke:do] ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  main,
  smokeInputFromEnv,
};
