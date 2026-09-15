// Object-storage backup destinations: what an owner types in, what is kept on
// this machine, and what the storage engine is told.
//
// MOS does not speak S3 itself. restic's S3 backend already works across AWS,
// Backblaze B2, Wasabi, Cloudflare R2, Garage, Ceph and MinIO, and a request
// signer written here would be a second, far less exercised implementation of
// the one detail that has to be exactly right for every one of them. So this
// file's whole job is turning an endpoint, a bucket and a key pair into a
// repository string plus two environment variables — and keeping the secret
// out of everything that is not those.
//
// The credentials are written root-only into the backup agent's state
// directory, which `managedStateTargets` classifies machine-local and never
// backs up. A backup carrying the credentials of the bucket it is stored in
// would hand whoever reads one copy the ability to delete every other.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OBJECT_DESTINATION_PREFIX = 'object:';
const CONFIG_FILENAME = 'object-destinations.json';
const CONFIG_VERSION = 1;
const BACKUPS_DIRNAME = 'MOS-backups';
const REPOSITORY_DIRNAME = 'repository';
const MAX_OBJECT_DESTINATIONS = 8;

function isObjectDestinationId(value) {
  return typeof value === 'string' && value.startsWith(OBJECT_DESTINATION_PREFIX) && value.length > OBJECT_DESTINATION_PREFIX.length;
}

function newObjectDestinationId() {
  return `${OBJECT_DESTINATION_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
}

// The endpoint names a host, never a bucket or a folder: those are separate
// fields, and accepting them here would produce a repository address that
// silently disagrees with what the rest of the dialog says.
function normalizeEndpoint(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Enter the storage endpoint, for example https://s3.eu-central-003.backblazeb2.com.');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('That endpoint is not a valid address. It should look like https://s3.eu-central-1.amazonaws.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The endpoint must be an https:// address, or http:// for storage on your own network.');
  if (url.username || url.password) throw new Error('Remove the user name and password from the endpoint and enter the access key below instead.');
  if (url.pathname && url.pathname !== '/') throw new Error('Enter the endpoint host only, without the bucket or folder. Those have their own fields.');
  if (url.search || url.hash) throw new Error('Enter the endpoint host only, without anything after it.');
  if (!url.hostname) throw new Error('That endpoint is missing a host name.');
  return `${url.protocol}//${url.host}`;
}

function normalizeBucket(value) {
  const bucket = String(value ?? '').trim();
  if (!bucket) throw new Error('Enter the name of the bucket to store backups in.');
  if (bucket.includes('..') || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new Error('A bucket name is 3 to 63 characters of lowercase letters, digits, dots and dashes, and cannot begin or end with a dot or dash.');
  }
  return bucket;
}

// Optional, and the reason one bucket can hold the backups of several servers
// without them writing over each other.
function normalizeFolder(value) {
  const raw = String(value ?? '').trim().replace(/^\/+|\/+$/gu, '');
  if (!raw) return '';
  const segments = raw.split('/');
  if (segments.length > 8) throw new Error('That folder is nested deeper than MOS stores backups in.');
  if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))) {
    throw new Error('A folder can use letters, digits, dots, dashes and underscores, separated by /.');
  }
  return segments.join('/');
}

function normalizeRegion(value) {
  const region = String(value ?? '').trim();
  if (!region) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u.test(region)) throw new Error('A region looks like eu-central-1. Leave it empty if your provider does not use one.');
  return region;
}

function normalizeAccessKeyId(value) {
  const key = String(value ?? '').trim();
  if (!key) throw new Error('Enter the access key ID for this bucket.');
  if (!/^[\x21-\x7e]{4,256}$/u.test(key)) throw new Error('That access key ID contains characters a storage provider does not issue.');
  return key;
}

function normalizeSecretAccessKey(value) {
  const secret = String(value ?? '');
  if (!secret.trim()) throw new Error('Enter the secret access key for this bucket.');
  if (!/^[\x21-\x7e]{8,512}$/u.test(secret.trim())) throw new Error('That secret access key contains characters a storage provider does not issue.');
  return secret.trim();
}

function defaultLabel(endpoint, bucket) {
  try {
    return `${bucket} at ${new URL(endpoint).hostname}`;
  } catch {
    return bucket;
  }
}

function normalizeLabel(value, endpoint, bucket) {
  const label = String(value ?? '').trim().slice(0, 80);
  return label || defaultLabel(endpoint, bucket);
}

// An edit re-sends every field except the secret, which the screen never
// receives back and therefore cannot return. An empty secret on an edit means
// "keep the one you have"; on a new destination it is simply missing.
function normalizeObjectDestination(input = {}, existing = null) {
  const endpoint = normalizeEndpoint(input.endpoint);
  const bucket = normalizeBucket(input.bucket);
  const secretGiven = String(input.secretAccessKey ?? '').trim();
  if (!secretGiven && !existing?.secretAccessKey) normalizeSecretAccessKey(input.secretAccessKey);
  return {
    accessKeyId: normalizeAccessKeyId(input.accessKeyId),
    bucket,
    createdAt: existing?.createdAt || new Date().toISOString(),
    endpoint,
    folder: normalizeFolder(input.folder),
    id: existing?.id || newObjectDestinationId(),
    label: normalizeLabel(input.label, endpoint, bucket),
    region: normalizeRegion(input.region),
    secretAccessKey: secretGiven ? normalizeSecretAccessKey(secretGiven) : existing.secretAccessKey,
  };
}

// The repository lives under the same MOS-backups/repository shape a drive
// uses, so a bucket an owner opens in a provider's file browser looks like the
// drive they already know, and the names above it stay free for whatever a
// later version needs to put beside a repository.
function objectRepositorySpec(record) {
  const prefix = [record.folder, BACKUPS_DIRNAME, REPOSITORY_DIRNAME].filter(Boolean).join('/');
  return {
    env: {
      AWS_ACCESS_KEY_ID: record.accessKeyId,
      AWS_SECRET_ACCESS_KEY: record.secretAccessKey,
      ...(record.region ? { AWS_DEFAULT_REGION: record.region } : {}),
    },
    location: `s3:${record.endpoint}/${record.bucket}/${prefix}`,
    secrets: [record.secretAccessKey, record.accessKeyId],
  };
}

// What leaves the agent. The access key ID stays: it is an identifier rather
// than a secret — the thing it identifies is the secret — and without it an
// owner with several keys cannot tell which one a bucket is using.
function publicObjectDestination(record) {
  return {
    accessKeyId: record.accessKeyId,
    bucket: record.bucket,
    createdAt: record.createdAt || null,
    endpoint: record.endpoint,
    folder: record.folder || '',
    id: record.id,
    label: record.label,
    region: record.region || '',
  };
}

class ObjectDestinationRegistry {
  constructor({ agentStateDir, configPath } = {}) {
    this.configPath = configPath || path.join(agentStateDir || '.', CONFIG_FILENAME);
  }

  list() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return Array.isArray(parsed.destinations) ? parsed.destinations.filter((entry) => isObjectDestinationId(entry?.id)) : [];
    } catch {
      return [];
    }
  }

  get(id) {
    return this.list().find((entry) => entry.id === id) || null;
  }

  // Written 0600 with the mode reasserted, because writeFileSync's mode only
  // applies to a file it creates: without the chmod, a config that ever existed
  // with looser permissions would silently keep them.
  write(destinations) {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, `${JSON.stringify({ destinations, version: CONFIG_VERSION }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(this.configPath, 0o600);
  }

  save(input = {}) {
    const destinations = this.list();
    const existing = input.id ? destinations.find((entry) => entry.id === input.id) : null;
    if (input.id && !existing) throw new Error('That storage connection no longer exists.');
    if (!existing && destinations.length >= MAX_OBJECT_DESTINATIONS) throw new Error(`MOS holds up to ${MAX_OBJECT_DESTINATIONS} storage connections. Disconnect one you no longer use first.`);
    const record = normalizeObjectDestination(input, existing);
    // Two connections to the same place would each believe they own the
    // repository, and a schedule pointed at one would prune what the other
    // wrote without ever listing it.
    const clash = destinations.find((entry) => entry.id !== record.id && entry.endpoint === record.endpoint && entry.bucket === record.bucket && (entry.folder || '') === record.folder);
    if (clash) throw new Error(`This bucket and folder are already connected as "${clash.label}".`);
    this.write(existing ? destinations.map((entry) => (entry.id === record.id ? record : entry)) : [...destinations, record]);
    return record;
  }

  remove(id) {
    const destinations = this.list();
    const existing = destinations.find((entry) => entry.id === id);
    if (!existing) throw new Error('That storage connection no longer exists.');
    this.write(destinations.filter((entry) => entry.id !== id));
    return existing;
  }
}

module.exports = {
  BACKUPS_DIRNAME,
  isObjectDestinationId,
  MAX_OBJECT_DESTINATIONS,
  normalizeObjectDestination,
  ObjectDestinationRegistry,
  OBJECT_DESTINATION_PREFIX,
  objectRepositorySpec,
  publicObjectDestination,
  REPOSITORY_DIRNAME,
};
