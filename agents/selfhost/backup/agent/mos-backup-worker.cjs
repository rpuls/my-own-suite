#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoDir = process.env.MOS_BACKUP_AGENT_REPO_DIR || process.cwd();
const jobFile = process.argv[process.argv.indexOf('--job-file') + 1];
const composeScript = path.join(repoDir, 'scripts', 'mos-compose.cjs');
const expectedVolumes = [
  'caddy_config',
  'caddy_data',
  'homepage_images',
  'immich_db',
  'immich_model_cache',
  'immich_upload',
  'onlyoffice_data',
  'radicale_data',
  'seafile_data',
  'seafile_mysql_data',
  'stirling_pdf_custom_files',
  'stirling_pdf_extra_configs',
  'stirling_pdf_logs',
  'stirling_pdf_pipeline',
  'stirling_pdf_training_data',
  'suite_manager_data',
  'vaultwarden_data',
  'vaultwarden_postgres_data',
];
const serviceProfiles = {
  immich: 'immich',
  'immich-machine-learning': 'immich',
  'immich-postgres': 'immich',
  'immich-valkey': 'immich',
  onlyoffice: 'onlyoffice',
  radicale: 'radicale',
  seafile: 'seafile',
  'seafile-mysql': 'seafile',
  'seafile-valkey': 'seafile',
  'stirling-pdf': 'stirling-pdf',
  vaultwarden: 'vaultwarden',
  'vaultwarden-postgres': 'vaultwarden',
};

if (!jobFile) {
  process.stderr.write('Missing --job-file.\n');
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function updateJob(mutator) {
  const job = readJson(jobFile);
  mutator(job);
  job.updatedAt = new Date().toISOString();
  writeJson(jobFile, job);
  writeJson(path.join(path.dirname(path.dirname(jobFile)), 'current-job.json'), job);
  return job;
}

function log(message) {
  updateJob((job) => {
    job.logs = Array.isArray(job.logs) ? job.logs : [];
    job.logs.push({ at: new Date().toISOString(), message });
  });
}

function stage(name) {
  updateJob((job) => {
    job.stage = name;
    job.status = 'running';
  });
  log(name);
}

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: options.cwd || repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 120_000,
  }).trim();
}

function optionalCommand(commandName, args, options = {}) {
  try {
    return command(commandName, args, options);
  } catch {
    return null;
  }
}

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.cpSync(source, target, {
    dereference: false,
    errorOnExist: false,
    force: true,
    preserveTimestamps: true,
    recursive: true,
  });
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sanitizeArchiveName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function dockerJson(args) {
  return parseJson(command('docker', args), null);
}

function compose(args, options = {}) {
  return command(process.execPath, [composeScript, ...args], {
    timeout: options.timeout || 600_000,
  });
}

function profileArgs(profiles) {
  return profiles.flatMap((profile) => ['--profile', profile]);
}

function getRunningServices() {
  const output = optionalCommand('docker', [
    'ps',
    '--filter',
    'label=com.docker.compose.project=mos',
    '--format',
    '{{.Label "com.docker.compose.service"}}',
  ]);

  if (!output) {
    return [];
  }

  return Array.from(new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))).sort();
}

function getActiveProfiles(services) {
  return Array.from(new Set(services.map((service) => serviceProfiles[service]).filter(Boolean))).sort();
}

function listDockerVolumes() {
  const labeled = optionalCommand('docker', [
    'volume',
    'ls',
    '--filter',
    'label=com.docker.compose.project=mos',
    '--format',
    '{{.Name}}',
  ]);
  const labeledVolumes = labeled ? labeled.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];

  if (labeledVolumes.length > 0) {
    return Array.from(new Set(labeledVolumes)).sort();
  }

  const existing = [];
  for (const volume of expectedVolumes) {
    const volumeName = `mos_${volume}`;
    const inspected = optionalCommand('docker', ['volume', 'inspect', volumeName]);
    if (inspected) {
      existing.push(volumeName);
    }
  }

  return existing.sort();
}

function inspectVolume(volumeName) {
  const inspected = dockerJson(['volume', 'inspect', volumeName]);
  if (!Array.isArray(inspected) || !inspected[0]) {
    throw new Error(`Unable to inspect Docker volume ${volumeName}.`);
  }

  const mountpoint = inspected[0].Mountpoint;
  if (typeof mountpoint !== 'string' || !mountpoint.trim()) {
    throw new Error(`Docker volume ${volumeName} did not report a mountpoint.`);
  }

  return {
    driver: typeof inspected[0].Driver === 'string' ? inspected[0].Driver : null,
    labels: inspected[0].Labels && typeof inspected[0].Labels === 'object' ? inspected[0].Labels : {},
    mountpoint,
    name: volumeName,
  };
}

function archiveVolume(volume, outputDir) {
  const archiveName = `${sanitizeArchiveName(volume.name)}.tar.gz`;
  const archivePath = path.join(outputDir, archiveName);
  fs.mkdirSync(outputDir, { recursive: true });
  command('tar', ['-czf', archivePath, '-C', volume.mountpoint, '.'], { timeout: 1_800_000 });
  return {
    archive: archiveName,
    bytes: fs.statSync(archivePath).size,
    sha256: sha256File(archivePath),
  };
}

function directorySizeBytes(dirPath) {
  const output = optionalCommand('du', ['-sb', dirPath], { timeout: 300_000 });
  if (!output) {
    return null;
  }

  const bytes = Number(output.split(/\s+/)[0]);
  return Number.isFinite(bytes) ? bytes : null;
}

function availableBytes(dirPath) {
  try {
    const stat = fs.statfsSync(dirPath);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

function assertDestinationHasSpace(destinationId, volumes) {
  const available = availableBytes(destinationId);
  if (available === null) {
    log('Skipping free-space preflight because destination free space could not be read.');
    return {
      availableBytes: null,
      requiredBytes: null,
    };
  }

  let measuredAllVolumes = true;
  const requiredBytes = volumes.reduce((total, volume) => {
    const bytes = directorySizeBytes(volume.mountpoint);
    if (bytes === null) {
      measuredAllVolumes = false;
      return total;
    }
    return total + bytes;
  }, 0);

  if (!measuredAllVolumes) {
    log('Skipping strict free-space preflight because one or more volume sizes could not be measured.');
    return {
      availableBytes: available,
      requiredBytes: null,
    };
  }

  const reserveBytes = 512 * 1024 * 1024;
  if (available < requiredBytes + reserveBytes) {
    throw new Error(
      `Selected destination has ${available} bytes free, but the detected Docker volumes use about ${requiredBytes} bytes before compression.`,
    );
  }

  return {
    availableBytes: available,
    requiredBytes,
  };
}

function sha256File(filePath) {
  const output = command('sha256sum', [filePath], { timeout: 300_000 });
  return output.split(/\s+/)[0] || null;
}

function writeTextFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

function writeRestoreNotes(outputDir) {
  writeTextFile(
    path.join(outputDir, 'RESTORE.md'),
    [
      '# My Own Suite backup',
      '',
      'This folder contains an offline My Own Suite backup bundle.',
      '',
      'Contents:',
      '',
      '- `manifest.json`: backup metadata, source version/commit, active profiles, and archive checksums.',
      '- `mos-config.tar.gz`: repo-managed runtime configuration archive.',
      '- `config/`: readable copy of runtime configuration included in the archive.',
      '- `compose/docker-compose.config.yml`: rendered Docker Compose configuration from backup time.',
      '- `volumes/*.tar.gz`: cold Docker volume archives.',
      '',
      'Restore is intentionally version-paired. Check out or install the MOS version/commit recorded in `manifest.json` before restoring these files and volumes.',
      '',
      'Automated restore support is still being implemented. Until then, keep this whole folder intact and do not edit the archives.',
    ].join('\n'),
  );
}

function buildManifest(job, outputDir, snapshot) {
  const versionPath = path.join(repoDir, 'VERSION');
  const stablePath = path.join(repoDir, 'releases', 'stable.json');
  return {
    backup: {
      createdAt: new Date().toISOString(),
      id: job.id,
      kind: 'mos-offline-snapshot',
      schemaVersion: 1,
    },
    source: {
      activeProfiles: snapshot.activeProfiles,
      runningServices: snapshot.runningServices,
      branch: optionalCommand('git', ['branch', '--show-current']),
      commit: optionalCommand('git', ['rev-parse', 'HEAD']),
      repoDir,
      version: fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : null,
      release: fs.existsSync(stablePath) ? JSON.parse(fs.readFileSync(stablePath, 'utf8')) : null,
    },
    preflight: {
      destinationAvailableBytes: snapshot.preflight.availableBytes,
      estimatedVolumeBytes: snapshot.preflight.requiredBytes,
    },
    contents: {
      configArchive: path.relative(outputDir, path.join(outputDir, 'mos-config.tar.gz')),
      configArchiveBytes: snapshot.configArchive.bytes,
      configArchiveSha256: snapshot.configArchive.sha256,
      composeConfig: path.relative(outputDir, path.join(outputDir, 'compose', 'docker-compose.config.yml')),
      volumes: snapshot.volumes.map((volume) => ({
        archive: path.join('volumes', volume.archive),
        archiveBytes: volume.bytes,
        archiveSha256: volume.sha256,
        driver: volume.driver,
        labels: volume.labels,
        mountpoint: volume.mountpoint,
        name: volume.name,
      })),
    },
    restore: {
      status: 'planned',
      requiresVersionPairing: true,
    },
  };
}

function main() {
  const started = updateJob((job) => {
    job.stage = 'starting';
    job.status = 'running';
  });

  try {
    stage('Preparing backup directory');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(started.destinationId, 'MOS-backups', `mos-backup-${stamp}-${started.id.slice(0, 8)}`);
    fs.mkdirSync(outputDir, { recursive: true });
    updateJob((job) => {
      job.outputPath = outputDir;
    });

    stage('Collecting suite metadata');
    const runningServices = getRunningServices();
    const activeProfiles = getActiveProfiles(runningServices);
    const volumes = listDockerVolumes().map(inspectVolume);
    const preflight = assertDestinationHasSpace(started.destinationId, volumes);

    stage('Copying runtime configuration');
    const configRoot = path.join(outputDir, 'config');
    fs.mkdirSync(configRoot, { recursive: true });
    copyIfExists(path.join(repoDir, 'deploy', 'vps', '.env'), path.join(configRoot, 'deploy-vps.env'));
    copyIfExists(path.join(repoDir, 'deploy', 'vps', 'services'), path.join(configRoot, 'services'));
    copyIfExists(path.join(repoDir, 'deploy', 'vps', 'docker-compose.selfhost.yml'), path.join(configRoot, 'docker-compose.selfhost.yml'));

    stage('Writing configuration archive');
    const tarOutput = path.join(outputDir, 'mos-config.tar.gz');
    command('tar', ['-czf', tarOutput, '-C', configRoot, '.'], { timeout: 300_000 });
    const configArchive = {
      bytes: fs.existsSync(tarOutput) ? fs.statSync(tarOutput).size : null,
      sha256: fs.existsSync(tarOutput) ? sha256File(tarOutput) : null,
    };

    stage('Recording Compose configuration');
    const composeConfig = compose([...profileArgs(activeProfiles), 'config'], { timeout: 300_000 });
    writeTextFile(path.join(outputDir, 'compose', 'docker-compose.config.yml'), composeConfig);

    stage('Stopping MOS stack for cold volume snapshot');
    compose([...profileArgs(activeProfiles), 'stop'], { timeout: 600_000 });

    const archivedVolumes = [];
    try {
      stage('Archiving Docker volumes');
      for (const volume of volumes) {
        log(`Archiving volume ${volume.name}`);
        const archived = archiveVolume(volume, path.join(outputDir, 'volumes'));
        archivedVolumes.push({
          ...volume,
          ...archived,
        });
      }
    } finally {
      stage('Restarting MOS stack');
      compose([...profileArgs(activeProfiles), 'up', '-d'], { timeout: 900_000 });
    }

    stage('Writing backup manifest');
    const manifest = buildManifest(started, outputDir, {
      activeProfiles,
      configArchive,
      preflight,
      runningServices,
      volumes: archivedVolumes,
    });
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    writeRestoreNotes(outputDir);

    updateJob((job) => {
      job.stage = 'completed';
      job.status = 'succeeded';
    });
  } catch (error) {
    updateJob((job) => {
      job.error = error instanceof Error ? error.message : String(error);
      job.stage = 'failed';
      job.status = 'failed';
    });
  }
}

main();
