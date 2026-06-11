#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const token = process.env.MOS_SELFHOST_SIMULATOR_TOKEN || 'dev-selfhost-simulator-token';

const agents = {
  backup: {
    service: 'mos-backup-agent',
    socketPath: '/run/mos-backup-agent/agent.sock',
    tokenFile: '/etc/mos-backup-agent/auth.token',
  },
  service: {
    service: 'mos-service-agent',
    socketPath: '/run/mos-service-agent/agent.sock',
    tokenFile: '/etc/mos-service-agent/auth.token',
  },
  update: {
    service: 'mos-update-agent',
    socketPath: '/run/mos-update-agent/agent.sock',
    tokenFile: '/etc/mos-update-agent/auth.token',
  },
};

let updateTrack = {
  currentBranch: 'staging',
  currentCommit: '77449619478e3dc5bb2c428d48f998f89487b3b7',
  label: 'Staging branch',
  ref: 'staging',
  source: 'selfhost simulator',
  type: 'branch',
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeToken(filePath) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${token}\n`, 'utf8');
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function authenticate(request) {
  const header = request.headers.authorization || '';
  return header === `Bearer ${token}`;
}

function setupSocket(socketPath) {
  ensureDir(path.dirname(socketPath));
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {}
}

function latestRelease() {
  return {
    channel: 'stable',
    notesUrl: 'https://github.com/rpuls/my-own-suite/releases',
    publishedAt: '2026-06-07T00:00:00Z',
    source: 'github-release',
    version: process.env.MOS_SELFHOST_SIMULATOR_LATEST_VERSION || '0.11.0',
  };
}

function updateStatus() {
  const branchTrack = updateTrack.type === 'branch';
  return {
    checkedAt: new Date().toISOString(),
    changeSummary: {
      items: [
        'Preview self-host update controls without installing host agents.',
        'Show branch-track updates as commits instead of release numbers.',
        'Keep technical job output behind Advanced details.',
      ],
      source: branchTrack ? 'Simulated CHANGELOG.md [Unreleased]' : 'Simulated CHANGELOG.md [0.11.0]',
      title: branchTrack ? 'Upcoming changes on staging' : 'Changes in 0.11.0',
    },
    error: null,
    githubRepo: 'rpuls/my-own-suite',
    installedVersion: process.env.MOS_SELFHOST_SIMULATOR_INSTALLED_VERSION || '0.11.0',
    installedVersionSource: 'self-host simulator',
    latestRelease: latestRelease(),
    latestRevision: branchTrack ? 'a81c92f458ddc74f937b7f5c3b5f1a2dcb1a6f0b' : null,
    stateFile: 'self-host simulator',
    track: updateTrack,
    updateAvailable: branchTrack,
  };
}

function updateJob(target = 'latest') {
  return {
    error: null,
    id: crypto.randomUUID(),
    logs: [
      { at: new Date().toISOString(), message: 'Simulator: would fetch latest update metadata.' },
      { at: new Date().toISOString(), message: 'Simulator: would rebuild and restart the MOS stack.' },
    ],
    stage: 'simulated',
    status: 'succeeded',
    target,
    updatedAt: new Date().toISOString(),
  };
}

async function handleUpdate(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/v1/status') {
    json(response, 200, {
      capabilities: {
        updates: { capabilities: ['apply', 'configure-track'] },
      },
      currentJob: null,
      lastJob: updateJob(),
      repoDir: '/simulated/repo',
      service: agents.update.service,
      socketPath: agents.update.socketPath,
      updaterStatus: updateStatus(),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/track') {
    const rawBody = await readBody(request);
    const body = rawBody.trim() ? JSON.parse(rawBody) : {};
    if (body.track === 'branch') {
      updateTrack = {
        currentBranch: 'staging',
        currentCommit: updateStatus().track.currentCommit,
        label: 'Staging branch',
        ref: body.ref || 'staging',
        source: 'selfhost simulator',
        type: 'branch',
      };
    } else {
      updateTrack = {
        currentBranch: 'main',
        currentCommit: 'fd53242c50be4d5d7de82c2f2df345a247821c64',
        label: 'Stable releases',
        ref: 'main',
        source: 'selfhost simulator',
        type: 'stable',
      };
    }

    json(response, 200, {
      track: updateTrack,
      updaterStatus: updateStatus(),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/jobs') {
    const rawBody = await readBody(request);
    const body = rawBody.trim() ? JSON.parse(rawBody) : {};
    json(response, 202, { job: updateJob(body.target || 'latest') });
    return;
  }

  json(response, 404, { error: 'Not found.' });
}

function backupStatus() {
  return {
    backups: [
      {
        activeProfiles: ['vaultwarden', 'seafile', 'radicale'],
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
        destinationId: 'sim-usb',
        destinationLabel: 'Simulated USB backup drive',
        id: 'sim-backup-001',
        path: '/media/mos-backup/simulated/mos-backup-001',
        schemaVersion: 1,
        sourceCommit: '77449619478e3dc5bb2c428d48f998f89487b3b7',
        sourceVersion: '0.11.0',
        totalVolumeArchiveBytes: 5_368_709_120,
        volumeCount: 6,
      },
    ],
    capabilities: {
      backups: { capabilities: ['create', 'list'] },
      destinations: { capabilities: ['list', 'mount'] },
      restores: { capabilities: ['plan', 'apply'] },
    },
    currentJob: null,
    destinations: [
      {
        availableBytes: 120_000_000_000,
        fileSystem: 'ext4',
        id: 'sim-usb',
        label: 'Simulated USB backup drive',
        mountPath: '/media/mos-backup/sim-usb',
        mountState: 'mounted',
        sizeBytes: 256_000_000_000,
        storageKind: 'external',
        transport: 'usb',
        writable: true,
      },
      {
        availableBytes: null,
        canMount: true,
        devicePath: '/dev/sdz1',
        fileSystem: 'ext4',
        id: 'sim-unmounted',
        label: 'Simulated unmounted drive',
        mountPath: null,
        mountState: 'unmounted',
        sizeBytes: 128_000_000_000,
        storageKind: 'external',
        transport: 'usb',
        writable: false,
      },
    ],
    lastJob: {
      backupPath: '/media/mos-backup/sim-usb/mos-backup-001',
      destinationId: 'sim-usb',
      error: null,
      id: 'sim-last-backup',
      kind: 'backup',
      logs: [{ at: new Date().toISOString(), message: 'Simulator: backup completed successfully.' }],
      outputPath: '/media/mos-backup/sim-usb/mos-backup-001',
      rescuePath: null,
      stage: 'succeeded',
      status: 'succeeded',
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    repoDir: '/simulated/repo',
    service: agents.backup.service,
    socketPath: agents.backup.socketPath,
  };
}

async function handleBackup(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/v1/status') {
    json(response, 200, backupStatus());
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/destinations/mount') {
    json(response, 200, { destination: backupStatus().destinations[0] });
    return;
  }

  if (request.method === 'POST' && (url.pathname === '/v1/jobs' || url.pathname === '/v1/restores')) {
    json(response, 202, { job: backupStatus().lastJob });
    return;
  }

  json(response, 404, { error: 'Not found.' });
}

function handleService(_request, response, url) {
  if (url.pathname === '/v1/status') {
    json(response, 200, {
      capabilities: {
        caddy: { capabilities: ['restart', 'external-proxies.apply'], container: 'mos-caddy' },
        homepage: { capabilities: ['restart'], container: 'mos-homepage' },
        'app-catalog': { capabilities: ['compose-selection.apply'] },
        settings: { capabilities: ['local-https.apply'] },
      },
      service: agents.service.service,
      socketPath: agents.service.socketPath,
    });
    return;
  }

  json(response, 200, { ok: true, service: agents.service.service });
}

function listen(agent, handler) {
  writeToken(agent.tokenFile);
  setupSocket(agent.socketPath);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      json(response, 200, { ok: true, service: agent.service });
      return;
    }

    if (!authenticate(request)) {
      json(response, 401, { error: 'Unauthorized.' });
      return;
    }

    try {
      await handler(request, response, url);
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : 'Simulator request failed.' });
    }
  });

  server.listen(agent.socketPath, () => {
    process.stdout.write(`[selfhost-agent-simulator] ${agent.service} listening on ${agent.socketPath}\n`);
  });
}

listen(agents.update, handleUpdate);
listen(agents.backup, handleBackup);
listen(agents.service, handleService);

process.stdin.resume();
