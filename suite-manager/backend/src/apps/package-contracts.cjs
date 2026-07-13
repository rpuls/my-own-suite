const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PACKAGE_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxFiles: 256,
  maxPackageBytes: 128 * 1024 * 1024,
});
const ALLOWED_ROOT_FILES = /^(?:Dockerfile(?:\.[a-z0-9][a-z0-9-]*)?|README\.md|entrypoint\.sh|icon\.(?:avif|gif|jpe?g|png|svg|webp)|manifest\.json|privacy-review\.json)$/iu;
const TEXT_FILE = /(?:^Dockerfile(?:\.|$)|\.(?:cjs|css|html|js|json|md|mjs|sh|svg|txt|yaml|yml)$)/iu;

class AppPackageContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.code = 'INVALID_APP_PACKAGE_CONTENTS';
    this.details = details;
  }
}

function canonicalPackagePath(relativePath) {
  if (String(relativePath).includes('\\')) return null;
  const portable = String(relativePath);
  if (!portable || portable.includes('\0') || path.posix.isAbsolute(portable)) return null;
  const normalized = path.posix.normalize(portable);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== portable) return null;
  return normalized;
}

function isAllowedPackageFile(relativePath, manifest) {
  if (ALLOWED_ROOT_FILES.test(relativePath)) return true;
  const declared = Array.isArray(manifest?.packageFiles) ? manifest.packageFiles : [];
  return declared.includes(relativePath);
}

function canonicalFileBytes(relativePath, bytes) {
  if (!TEXT_FILE.test(relativePath)) return bytes;
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0) {
    throw new AppPackageContractError(`Text package file is not valid UTF-8: ${relativePath}.`);
  }
  if (relativePath === 'privacy-review.json') {
    const review = JSON.parse(text);
    if (review?.scope) review.scope.packageDigest = 'sha256:<package-digest>';
    return Buffer.from(`${JSON.stringify(review, null, 2)}\n`, 'utf8');
  }
  return Buffer.from(text.replace(/\r\n?/gu, '\n'), 'utf8');
}

function collectPackageFiles(packageDir, { limits = DEFAULT_PACKAGE_LIMITS, manifest = null } = {}) {
  const errors = [];
  const files = [];
  let totalBytes = 0;
  const visit = (directory, relativeRoot = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relativePath = canonicalPackagePath(relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name);
      if (!relativePath) {
        errors.push(`Package path is not canonical: ${relativeRoot}/${entry.name}.`);
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        errors.push(`Package must not contain symlinks: ${relativePath}.`);
      } else if (stat.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (!stat.isFile()) {
        errors.push(`Package must contain regular files only: ${relativePath}.`);
      } else if (!isAllowedPackageFile(relativePath, manifest)) {
        errors.push(`Package file is not allowed or declared in manifest.packageFiles: ${relativePath}.`);
      } else {
        if (stat.size > limits.maxFileBytes) errors.push(`Package file exceeds ${limits.maxFileBytes} bytes: ${relativePath}.`);
        totalBytes += stat.size;
        files.push({ absolutePath, relativePath, size: stat.size });
      }
    }
  };
  visit(packageDir);
  if (files.length > limits.maxFiles) errors.push(`Package contains more than ${limits.maxFiles} files.`);
  if (totalBytes > limits.maxPackageBytes) errors.push(`Package exceeds ${limits.maxPackageBytes} bytes.`);
  if (errors.length) throw new AppPackageContractError(`Invalid app package contents at ${packageDir}.`, errors);
  return files.sort((left, right) => Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)));
}

function digestAppPackage(packageDir, options = {}) {
  const manifest = options.manifest || JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'));
  const hash = crypto.createHash('sha256');
  for (const file of collectPackageFiles(packageDir, { ...options, manifest })) {
    const bytes = canonicalFileBytes(file.relativePath, fs.readFileSync(file.absolutePath));
    const pathBytes = Buffer.from(file.relativePath, 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(pathBytes.length, 0);
    header.writeUInt32BE(bytes.length, 4);
    hash.update(header);
    hash.update(pathBytes);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

module.exports = {
  AppPackageContractError,
  DEFAULT_PACKAGE_LIMITS,
  canonicalPackagePath,
  collectPackageFiles,
  digestAppPackage,
};
