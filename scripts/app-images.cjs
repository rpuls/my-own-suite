const fs = require('node:fs');
const path = require('node:path');

// Names an image the way a privacy review's component inventory does: full
// registry path with no tag or digest, beside the tag and digest it pins.
function parseImageReference(reference) {
  const [withoutDigest, digest = null] = String(reference).split('@');
  const tagMatch = withoutDigest.match(/:([^/:]+)$/u);
  const parts = (tagMatch ? withoutDigest.slice(0, -tagMatch[0].length) : withoutDigest).split('/');
  if (parts.length === 1 || !/[.:]|^localhost$/u.test(parts[0])) parts.unshift('docker.io');
  if (parts.length === 2 && parts[0] === 'docker.io') parts.splice(1, 0, 'library');
  return { artifact: parts.join('/'), digest, tag: tagMatch ? tagMatch[1] : null };
}

// Every FROM in a package's Dockerfiles, primary `Dockerfile` first.
function readImagePins(packageDir) {
  return fs.readdirSync(packageDir)
    .filter((name) => name === 'Dockerfile' || name.startsWith('Dockerfile.'))
    .sort()
    .flatMap((dockerfile) => fs.readFileSync(path.join(packageDir, dockerfile), 'utf8')
      .split(/\r?\n/u)
      .filter((line) => /^FROM\s+/iu.test(line))
      .map((line) => ({ dockerfile, ...parseImageReference(line.split(/\s+/u)[1]) })));
}

function primaryImagePin(packageDir) {
  return readImagePins(packageDir).find((pin) => pin.dockerfile === 'Dockerfile') || null;
}

module.exports = { parseImageReference, primaryImagePin, readImagePins };
