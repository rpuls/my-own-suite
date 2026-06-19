#!/usr/bin/env node

const { renderBootstrapPlan } = require('./bootstrap-contract.cjs');

function usage() {
  console.log(`Usage: node scripts/installers/render-bootstrap.cjs [options]

Render a no-preconfig MOS V2 control-plane bootstrap contract.

Options:
  --target <json|env|cloud-init|ssh|usb>  Output format. Default: json.
  --repo-url <url>                        Repository URL. Defaults to the MOS GitHub repo.
  --repo-ref <ref>                        Branch, tag, or SHA. Defaults to feat/app-platform-v2-lab.
  --domain <domain>                       Base domain. Defaults to <public-ip>.sslip.io or localhost.
  --public-ipv4 <ip>                      Public IPv4 used to derive an sslip.io smoke domain.
  --front-door <name>                     cloud-init, usb-autoinstall, ssh-bootstrap, or digitalocean-smoke.
  --help                                  Show this help.
`);
}

function parseArgs(argv) {
  const input = {};
  let target = 'json';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}.`);
      }
      return argv[index];
    };

    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    if (arg === '--target') {
      target = next();
    } else if (arg === '--repo-url') {
      input.repoUrl = next();
    } else if (arg === '--repo-ref') {
      input.repoRef = next();
    } else if (arg === '--domain') {
      input.domain = next();
    } else if (arg === '--public-ipv4') {
      input.publicIpv4 = next();
    } else if (arg === '--front-door') {
      input.frontDoor = next();
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}.`);
    } else {
      throw new Error(`Unexpected argument: ${arg}.`);
    }
  }

  return { input, target };
}

function selectOutput(plan, target) {
  if (target === 'json') {
    return `${JSON.stringify(plan, null, 2)}\n`;
  }
  if (target === 'env') {
    return `${plan.env}\n`;
  }
  if (target === 'cloud-init') {
    return plan.cloudInit;
  }
  if (target === 'ssh') {
    return `${plan.sshBootstrap}\n`;
  }
  if (target === 'usb') {
    return plan.usbSeed;
  }

  throw new Error(`Unknown target: ${target}.`);
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    usage();
    return;
  }

  const plan = renderBootstrapPlan(parsed.input);
  process.stdout.write(selectOutput(plan, parsed.target));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[mos-v2:bootstrap] ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs,
  selectOutput,
};
