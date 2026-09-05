// Pinned installation of the backup storage engine binaries.
//
// Versions and their official checksums are adjacent constants and the
// download is refused unless it hashes to the pinned value, following the
// CoreDNS precedent in scripts/nameserver.cjs. Placement follows the Caddy
// precedent in scripts/reconcile-system.cjs: /usr/local/libexec/mos, mode
// 0755, written as .next and renamed, and driven from reconciliation so a
// machine that updates rather than reinstalls also gets the binary.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// `versionArgs` is per engine because the CLIs disagree: restic has a
// `version` subcommand, while kopia only answers `--version` and rejects
// `version` as an unknown command — a uniform invocation makes the freshness
// check below fail forever and every reconcile re-download the binary.
const ENGINE_RELEASES = Object.freeze({
  kopia: {
    archives: {
      arm64: { file: 'kopia-0.23.1-linux-arm64.tar.gz', sha256: 'a4ffbc019e0b0f932e2632054e73ec521dc1e80172a00095369c53ecf4e5a6cb' },
      x64: { file: 'kopia-0.23.1-linux-x64.tar.gz', sha256: '416d0f84a3dbb321a8b2d8f0997b1a0a6e915babe79ee76fa6e4d2bd1e1c5178' },
    },
    compression: 'tar.gz',
    repository: 'kopia/kopia',
    version: '0.23.1',
    versionArgs: ['--version'],
  },
  restic: {
    archives: {
      arm64: { file: 'restic_0.19.1_linux_arm64.bz2', sha256: 'a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465' },
      x64: { file: 'restic_0.19.1_linux_amd64.bz2', sha256: 'f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c' },
    },
    compression: 'bz2',
    repository: 'restic/restic',
    version: '0.19.1',
    versionArgs: ['version'],
  },
});

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length)) > 0) hash.update(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function downloadUrl(name, asset) {
  const release = ENGINE_RELEASES[name];
  return `https://github.com/${release.repository}/releases/download/v${release.version}/${asset.file}`;
}

function assetFor(name, arch = process.arch) {
  const asset = ENGINE_RELEASES[name]?.archives?.[arch];
  if (!asset) throw new Error(`No pinned ${name} build for ${arch}.`);
  return asset;
}

function installedVersion(binaryPath, versionArgs) {
  try {
    return execFileSync(binaryPath, versionArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }).trim();
  } catch {
    return null;
  }
}

function findBinary(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return absolute;
    if (entry.isDirectory()) {
      const nested = findBinary(absolute, name);
      if (nested) return nested;
    }
  }
  return null;
}

// Already-correct installs are left alone so reconciliation stays cheap: the
// pinned version string appearing in the binary's own output is the check.
function isCurrent(name, binaryPath) {
  const release = ENGINE_RELEASES[name];
  const reported = installedVersion(binaryPath, release.versionArgs);
  return Boolean(reported && reported.includes(release.version));
}

function installEngineBinary({ arch = process.arch, binaryDir, force = false, log = () => {}, name }) {
  const release = ENGINE_RELEASES[name];
  if (!release) throw new Error(`Unknown backup storage engine "${name}".`);
  const binaryPath = path.join(binaryDir, name);
  if (!force && isCurrent(name, binaryPath)) {
    log(`${name} ${release.version} is already installed`);
    return { binaryPath, installed: false, version: release.version };
  }
  const asset = assetFor(name, arch);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `mos-engine-${name}-`));
  try {
    const archivePath = path.join(workDir, asset.file);
    log(`Downloading ${name} ${release.version}`);
    execFileSync('curl', ['-fsSL', '-o', archivePath, downloadUrl(name, asset)], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600_000 });
    const actual = sha256File(archivePath);
    if (actual !== asset.sha256) {
      throw new Error(`Refusing to install ${name}: the download did not match its pinned checksum (expected ${asset.sha256}, got ${actual}).`);
    }
    fs.mkdirSync(binaryDir, { mode: 0o755, recursive: true });
    const stagedPath = `${binaryPath}.next`;
    if (release.compression === 'tar.gz') {
      execFileSync('tar', ['-xzf', archivePath, '-C', workDir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000 });
      const extracted = findBinary(workDir, name);
      if (!extracted) throw new Error(`The ${name} download did not contain a ${name} binary.`);
      fs.copyFileSync(extracted, stagedPath);
    } else {
      // restic publishes its Linux binaries bzip2-compressed and nothing
      // else, so installing it needs a bzip2 on the host. Ubuntu server
      // images do not all carry one, which is a real cost of choosing restic
      // rather than a detail — say so plainly instead of failing on ENOENT.
      try {
        fs.writeFileSync(stagedPath, execFileSync('bzip2', ['-dc', archivePath], { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }));
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`Cannot install ${name}: it ships bzip2-compressed and this machine has no bzip2.`);
        throw error;
      }
    }
    fs.chmodSync(stagedPath, 0o755);
    fs.renameSync(stagedPath, binaryPath);
  } finally {
    fs.rmSync(workDir, { force: true, recursive: true });
  }
  // The install is only complete when the binary answers, which also proves
  // the architecture and libc of the pinned build match this machine.
  if (!isCurrent(name, binaryPath)) {
    throw new Error(`The installed ${name} binary did not report version ${release.version}.`);
  }
  log(`Installed ${name} ${release.version}`);
  return { binaryPath, installed: true, version: release.version };
}

module.exports = { assetFor, downloadUrl, ENGINE_RELEASES, installedVersion, installEngineBinary, isCurrent, sha256File };
