#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SUPPORTED_UBUNTU_RELEASE = {
  label: 'Ubuntu Server 24.04.4 LTS',
  fileName: 'ubuntu-24.04.4-live-server-amd64.iso',
  isoUrl: 'https://releases.ubuntu.com/noble/ubuntu-24.04.4-live-server-amd64.iso',
  sha256Url: 'https://releases.ubuntu.com/noble/SHA256SUMS',
};

function readArg(name, fallback = '') {
  const prefixed = `--${name}=`;
  const valueWithEquals = process.argv.find((arg) => arg.startsWith(prefixed));
  if (valueWithEquals) {
    return valueWithEquals.slice(prefixed.length).trim();
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1].trim();
  }

  return fallback;
}

function requireArg(name, fallback = '') {
  const value = readArg(name, fallback);
  if (!value) {
    console.error(`Missing required --${name} argument.`);
    process.exit(1);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || 'pipe',
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (command === 'docker' && /dockerDesktopLinuxEngine|docker API|docker_engine/i.test(combinedOutput)) {
      console.error('WARNING: Docker Desktop is not running or not ready in Linux container mode.');
      console.error('Please make sure Docker Desktop is running. This is required to build the final self-host installer ISO.');
      console.error('Then wait until Docker says it is running and make sure Linux containers are enabled.');
    }
    console.error(`Command failed: ${command} ${args.join(' ')}`);
    process.exit(result.status || 1);
  }

  return result;
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`${label} not found: ${filePath}`);
    process.exit(1);
  }
}

// Node 19 made `keepAlive` the default on the global agent. A pooled socket the
// far end has already closed is not retried — the next request on it fails with
// `socket hang up` — and this script's requests are minutes apart around a
// multi-gigabyte transfer, which is exactly when that happens. Every request
// gets its own connection instead.
const REQUEST_OPTIONS = { agent: false };

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
]);

function isTransientNetworkError(error) {
  if (!error) return false;
  if (TRANSIENT_NETWORK_CODES.has(error.code)) return true;
  return /socket hang up|timed? ?out|ECONNRESET/iu.test(error.message || '');
}

// A build that has already spent eight minutes downloading should not be thrown
// away by one dropped connection.
async function withRetry(label, attempt, attempts = 4) {
  for (let tryNumber = 1; ; tryNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tryNumber >= attempts || !isTransientNetworkError(error)) throw error;
      const waitSeconds = 2 ** tryNumber;
      console.log(`${label} failed: ${error.message || String(error)}`);
      console.log(`Retrying in ${waitSeconds}s (attempt ${tryNumber + 1} of ${attempts}).`);
      await new Promise((resolve) => {
        setTimeout(resolve, waitSeconds * 1000);
      });
    }
  }
}

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, REQUEST_OPTIONS, (response) => {
      const statusCode = response.statusCode || 0;

      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error(`Too many redirects while requesting ${url}`));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        resolve(fetchUrl(nextUrl, redirectCount + 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Request failed for ${url} with status ${statusCode}`));
        return;
      }

      resolve(response);
    });

    request.on('error', reject);
  });
}

async function fetchText(url) {
  const response = await fetchUrl(url);
  return await new Promise((resolve, reject) => {
    let data = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      data += chunk;
    });
    response.on('end', () => resolve(data));
    response.on('error', reject);
  });
}

async function downloadFile(url, destinationPath) {
  const response = await fetchUrl(url);
  const totalBytes = Number(response.headers['content-length'] || 0);
  let downloadedBytes = 0;
  let lastPercentLogged = -10;

  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destinationPath);

    response.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes > 0) {
        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
        if (percent >= lastPercentLogged + 10) {
          lastPercentLogged = percent;
          console.log(`Download progress: ${percent}%`);
        }
      }
    });

    response.on('error', (error) => {
      output.destroy();
      reject(error);
    });

    output.on('error', reject);
    output.on('finish', resolve);

    response.pipe(output);
  });

  // `finish` only reports that the bytes which arrived were written, so a
  // connection that ends early still fires it. Without this the truncated file
  // reaches the checksum and reads as corruption rather than as the retryable
  // network failure it actually is.
  if (totalBytes > 0 && downloadedBytes !== totalBytes) {
    throw Object.assign(
      new Error(`Download ended early: ${downloadedBytes} of ${totalBytes} bytes from ${url}`),
      { code: 'ERR_STREAM_PREMATURE_CLOSE' },
    );
  }
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function ensureOfficialUbuntuIso(isoDropDir) {
  const isoTargetPath = path.join(isoDropDir, SUPPORTED_UBUNTU_RELEASE.fileName);
  console.log(`No Ubuntu ISO found in ${isoDropDir}`);
  console.log(`Downloading the official supported image: ${SUPPORTED_UBUNTU_RELEASE.label}`);
  console.log(`Source: ${SUPPORTED_UBUNTU_RELEASE.isoUrl}`);

  // The checksum list comes first deliberately. It is a few hundred bytes, so a
  // network problem costs a second instead of the eight minutes the ISO takes —
  // and nothing has to open a fresh connection immediately after a
  // multi-gigabyte transfer, which is where this used to fail.
  const sha256Sums = await withRetry(
    'Checksum download',
    () => fetchText(SUPPORTED_UBUNTU_RELEASE.sha256Url),
  );
  const expectedLine = sha256Sums
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(` ${SUPPORTED_UBUNTU_RELEASE.fileName}`) || line.trim().endsWith(`*${SUPPORTED_UBUNTU_RELEASE.fileName}`));

  if (!expectedLine) {
    console.error(`WARNING: checksum entry not found for ${SUPPORTED_UBUNTU_RELEASE.fileName}`);
    console.error(`Checksum source: ${SUPPORTED_UBUNTU_RELEASE.sha256Url}`);
    process.exit(1);
  }

  const expectedHash = expectedLine.trim().split(/\s+/)[0].toLowerCase();

  // A retried attempt truncates the file it is rewriting, so a partial download
  // is replaced rather than appended to.
  await withRetry(
    'ISO download',
    () => downloadFile(SUPPORTED_UBUNTU_RELEASE.isoUrl, isoTargetPath),
  );

  const actualHash = await sha256File(isoTargetPath);

  if (actualHash !== expectedHash) {
    await fs.promises.rm(isoTargetPath, { force: true });
    console.error('WARNING: downloaded Ubuntu ISO failed checksum verification.');
    console.error(`Expected: ${expectedHash}`);
    console.error(`Actual:   ${actualHash}`);
    console.error(`Official checksum source: ${SUPPORTED_UBUNTU_RELEASE.sha256Url}`);
    process.exit(1);
  }

  console.log(`Downloaded and verified official ISO: ${isoTargetPath}`);
  return isoTargetPath;
}

async function resolveInputIso(repoRoot) {
  const explicitIso = readArg('ubuntu-iso');
  if (explicitIso) {
    return path.resolve(repoRoot, explicitIso);
  }

  const isoDropDir = path.join(repoRoot, 'infrastructure', 'self-host', 'autoinstall', 'ubuntu-iso');
  fs.mkdirSync(isoDropDir, { recursive: true });

  const isoFiles = fs
    .readdirSync(isoDropDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.iso'))
    .map((entry) => path.join(isoDropDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  if (isoFiles.length === 0) {
    if (readArg('no-auto-download', '').toLowerCase() === 'true') {
      console.error(`No Ubuntu ISO found in ${isoDropDir}`);
      console.error('Automatic download is disabled. Place the official Ubuntu Server ISO there and run the builder again.');
      process.exit(1);
    }

    return ensureOfficialUbuntuIso(isoDropDir);
  }

  if (isoFiles.length > 1) {
    console.error(`Found multiple ISO files in ${isoDropDir}. Keep only one there or pass --ubuntu-iso explicitly.`);
    for (const isoFile of isoFiles) {
      console.error(`- ${isoFile}`);
    }
    process.exit(1);
  }

  return isoFiles[0];
}

async function main() {
  const repoRoot = process.cwd();
  const inputIso = await resolveInputIso(repoRoot);
  const explicitSeedDir = readArg('seed-dir');
  let seedDir;
  if (explicitSeedDir) {
    seedDir = path.resolve(repoRoot, explicitSeedDir);
  } else {
    console.log('Rendering the installer seed with defaults (no configuration required).');
    run(process.execPath, [path.join(repoRoot, 'scripts', 'installers', 'render-hyperv-usb-seed.cjs')], {
      stdio: 'inherit',
    });
    seedDir = path.join(repoRoot, '.mos-smoke', 'hyperv-usb', 'seed');
  }
  const outputIso = path.resolve(
    repoRoot,
    readArg('output-iso', 'infrastructure/self-host/output/my-own-suite-selfhost-installer.iso'),
  );
  const buildRoot = path.resolve(repoRoot, readArg('build-dir', '.tmp/selfhost-iso-build'));
  const builderTag = readArg('builder-tag', 'mos-selfhost-iso-builder:latest');
  const autoBoot = readArg('auto-boot', 'false').toLowerCase() === 'true';

  assertFile(inputIso, 'Ubuntu ISO');

  fs.rmSync(buildRoot, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(outputIso), { recursive: true });

  const passThroughArgs = [];
  for (const arg of process.argv.slice(2)) {
    if (
      arg.startsWith('--ubuntu-iso') ||
      arg.startsWith('--output-iso') ||
      arg.startsWith('--build-dir') ||
      arg.startsWith('--builder-tag') ||
      arg.startsWith('--installer-config') ||
      arg.startsWith('--no-auto-download')
      || arg.startsWith('--auto-boot')
      || arg.startsWith('--seed-dir')
    ) {
      continue;
    }
    passThroughArgs.push(arg);
  }

  assertFile(path.join(seedDir, 'user-data'), 'Generated user-data');
  assertFile(path.join(seedDir, 'meta-data'), 'Generated meta-data');

  run('docker', ['build', '-t', builderTag, 'infrastructure/self-host/iso-builder'], {
    stdio: 'inherit',
  });

  const normalizedSeedDir = seedDir.replace(/\\/g, '/');
  const normalizedOutputDir = path.dirname(outputIso).replace(/\\/g, '/');
  const normalizedInputDir = path.dirname(inputIso).replace(/\\/g, '/');
  const normalizedWorkspaceDir = path.join(buildRoot, 'workspace').replace(/\\/g, '/');
  const inputIsoBaseName = path.basename(inputIso);
  const outputIsoBaseName = path.basename(outputIso);

  fs.mkdirSync(path.join(buildRoot, 'workspace'), { recursive: true });

  run(
    'docker',
    [
      'run',
      '--rm',
      '-e',
      `INPUT_ISO_BASENAME=${inputIsoBaseName}`,
      '-e',
      `OUTPUT_ISO_BASENAME=${outputIsoBaseName}`,
      '-e',
      `MOS_INSTALLER_AUTO_BOOT=${autoBoot ? '1' : '0'}`,
      '-v',
      `${normalizedSeedDir}:/seed:ro`,
      '-v',
      `${normalizedWorkspaceDir}:/workspace`,
      '-v',
      `${normalizedInputDir}:/input:ro`,
      '-v',
      `${normalizedOutputDir}:/output`,
      builderTag,
    ],
    {
      stdio: 'inherit',
    },
  );

  console.log('');
  console.log('Self-host installer ISO is ready.');
  console.log(`Flash this file: ${outputIso}`);
  console.log(`Ubuntu ISO source: ${inputIso}`);
  console.log(`Installer seed source: ${seedDir}`);
  console.log('Ubuntu image source: official Ubuntu release URL verified against SHA256SUMS.');

  const seedSummaryPath = path.join(seedDir, 'seed-summary.json');
  if (fs.existsSync(seedSummaryPath)) {
    try {
      const seedSummary = JSON.parse(fs.readFileSync(seedSummaryPath, 'utf8'));
      console.log('');
      console.log(`Suite Home URL after install: ${seedSummary.home}`);
      if (seedSummary.consoleLoginHandover === 'preconfigured') {
        console.log('');
        console.log(`Server machine login: ${seedSummary.linuxUsername} / the LINUX_PASSWORD from your installer config.`);
        console.log('WARNING: this ISO carries that password. It is fine for your own machines, and');
        console.log('must never be published or shared — anyone holding the image holds the login.');
      } else {
        console.log('');
        console.log('Server machine login: generated by the installed machine on its first boot.');
        console.log('This ISO contains no password, so it is safe to copy and share.');
        console.log(`After install, ${seedSummary.linuxUsername}'s password appears on the server's own screen and`);
        console.log('in Suite Manager, which asks you to save it once and then deletes it.');
      }
    } catch {
      // A malformed summary only affects this convenience printout, never the ISO.
    }
  }
  console.log('');
  console.log('Recommended USB stick:');
  console.log('- Use a simple 8 GB or larger USB 3.0 stick from a reliable brand.');
  console.log('- Avoid very old sticks or drives with hardware encryption/software bundles.');
  console.log('');
  console.log('Rufus:');
  console.log('- Download: https://rufus.ie/');
  console.log('- Select the generated ISO above.');
  console.log('- Keep the default partition scheme Rufus suggests for the ISO.');
  console.log('- If Rufus asks between ISO mode and DD mode, use ISO mode unless you hit a hardware-specific boot problem.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`WARNING: failed to prepare the self-host installer ISO.`);
    console.error(error.message || String(error));
    process.exit(1);
  });
}
