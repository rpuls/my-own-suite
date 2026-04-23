import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import axios from 'axios';

import type { SuiteManagerConfig } from '../../config.ts';
import { readAgentStatus, startAgentUpdate } from './agent.ts';

type ReleaseSource = 'github-release' | 'local-manifest' | 'override' | 'unavailable';

type ReleaseManifest = {
  channel: string;
  notesUrl?: string;
  publishedAt?: string;
  version: string;
};

type InstalledVersion = {
  source: string | null;
  version: string | null;
};

export type UpdateStatus = {
  currentJob: {
    id: string;
    stage: string | null;
    status: string | null;
    target: string | null;
    updatedAt: string | null;
  } | null;
  checkedAt: string;
  error: string | null;
  installedVersion: string | null;
  installedVersionSource: string | null;
  latestRelease: {
    channel: string | null;
    notesUrl: string | null;
    publishedAt: string | null;
    source: ReleaseSource;
    version: string | null;
  };
  mode: 'managed' | 'notify-only';
  serviceAvailable: boolean;
  track: {
    currentBranch: string | null;
    currentCommit: string | null;
    label: string | null;
    ref: string | null;
    type: 'stable' | 'branch' | null;
  };
  updateAvailable: boolean;
};

const currentFilePath = fileURLToPath(import.meta.url);
const suiteManagerRoot = path.resolve(path.dirname(currentFilePath), '..', '..', '..');
const repoRoot = path.resolve(suiteManagerRoot, '..', '..');

function resolveExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getVersionFilePath(): string | null {
  return resolveExistingPath([
    path.join(process.cwd(), 'VERSION'),
    path.join(suiteManagerRoot, 'VERSION'),
    path.join(repoRoot, 'VERSION'),
  ]);
}

function getBundledReleaseMetadataPath(): string | null {
  return resolveExistingPath([path.join(process.cwd(), 'release.json'), path.join(suiteManagerRoot, 'release.json')]);
}

function getReleaseManifestPath(): string | null {
  return resolveExistingPath([
    path.join(process.cwd(), 'releases', 'stable.json'),
    path.join(suiteManagerRoot, 'releases', 'stable.json'),
    path.join(repoRoot, 'releases', 'stable.json'),
    path.join(process.cwd(), 'release.json'),
    path.join(suiteManagerRoot, 'release.json'),
  ]);
}

function normalizeVersion(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/^v/i, '');
}

function parseVersion(value: string | null): number[] | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }

  return match.slice(1).map((part) => Number(part));
}

function compareVersions(left: string | null, right: string | null): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  if (!leftParts || !rightParts) {
    return 0;
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }

    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
  }

  return 0;
}

function readReleaseManifestFromPath(filePath: string): ReleaseManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ReleaseManifest;
    if (!parsed.version) {
      return null;
    }

    return {
      channel: (parsed.channel || 'stable').trim() || 'stable',
      notesUrl: parsed.notesUrl?.trim() || undefined,
      publishedAt: parsed.publishedAt?.trim() || undefined,
      version: normalizeVersion(parsed.version) || parsed.version,
    };
  } catch {
    return null;
  }
}

function readInstalledVersion(): InstalledVersion {
  const versionFilePath = getVersionFilePath();

  if (versionFilePath) {
    try {
      return {
        source: versionFilePath,
        version: normalizeVersion(fs.readFileSync(versionFilePath, 'utf8')),
      };
    } catch {
      return {
        source: versionFilePath,
        version: null,
      };
    }
  }

  const bundledMetadataPath = getBundledReleaseMetadataPath();
  if (!bundledMetadataPath) {
    return {
      source: null,
      version: null,
    };
  }

  const bundledManifest = readReleaseManifestFromPath(bundledMetadataPath);
  return {
    source: bundledMetadataPath,
    version: bundledManifest?.version || null,
  };
}

function readLocalReleaseManifest(): ReleaseManifest | null {
  const releaseManifestPath = getReleaseManifestPath();

  if (!releaseManifestPath) {
    return null;
  }

  return readReleaseManifestFromPath(releaseManifestPath);
}

function buildOverrideRelease(config: SuiteManagerConfig): ReleaseManifest | null {
  const version = normalizeVersion(config.updates.latestVersionOverride);
  if (!version) {
    return null;
  }

  return {
    channel: 'stable',
    notesUrl: undefined,
    publishedAt: undefined,
    version,
  };
}

async function readLatestGitHubRelease(config: SuiteManagerConfig): Promise<ReleaseManifest | null> {
  if (!config.updates.enabled || !config.updates.githubRepo) {
    return null;
  }

  const response = await axios.get(`https://api.github.com/repos/${config.updates.githubRepo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'my-own-suite-suite-manager',
    },
    timeout: config.requestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300 || !response.data) {
    throw new Error(`GitHub release check failed with status ${response.status}.`);
  }

  const tagName =
    typeof response.data.tag_name === 'string'
      ? response.data.tag_name
      : typeof response.data.name === 'string'
        ? response.data.name
        : '';
  const version = normalizeVersion(tagName);

  if (!version) {
    throw new Error('Latest GitHub release did not include a usable tag.');
  }

  return {
    channel: 'stable',
    notesUrl:
      typeof response.data.html_url === 'string' && response.data.html_url.trim()
        ? response.data.html_url.trim()
        : undefined,
    publishedAt:
      typeof response.data.published_at === 'string' && response.data.published_at.trim()
        ? response.data.published_at.trim()
        : undefined,
    version,
  };
}

export class UpdatesService {
  private readonly config: SuiteManagerConfig;

  constructor(config: SuiteManagerConfig) {
    this.config = config;
  }

  async getStatus(): Promise<UpdateStatus> {
    if (this.config.updates.mode === 'managed' && this.config.updates.agentSocketPath && this.config.updates.agentTokenFile) {
      try {
        const agent = await readAgentStatus(this.config);
        const updaterStatus = agent.updaterStatus as Record<string, any>;
        const track = updaterStatus.track || null;

        return {
          checkedAt: typeof updaterStatus.checkedAt === 'string' ? updaterStatus.checkedAt : new Date().toISOString(),
          currentJob: agent.currentJob,
          error: typeof updaterStatus.error === 'string' ? updaterStatus.error : null,
          installedVersion: typeof updaterStatus.installedVersion === 'string' ? updaterStatus.installedVersion : null,
          installedVersionSource: typeof updaterStatus.installedVersionSource === 'string' ? updaterStatus.installedVersionSource : null,
          latestRelease: {
            channel: typeof updaterStatus.latestRelease?.channel === 'string' ? updaterStatus.latestRelease.channel : null,
            notesUrl: typeof updaterStatus.latestRelease?.notesUrl === 'string' ? updaterStatus.latestRelease.notesUrl : null,
            publishedAt:
              typeof updaterStatus.latestRelease?.publishedAt === 'string' ? updaterStatus.latestRelease.publishedAt : null,
            source:
              updaterStatus.latestRelease?.source === 'github-release' ||
              updaterStatus.latestRelease?.source === 'local-manifest' ||
              updaterStatus.latestRelease?.source === 'override'
                ? updaterStatus.latestRelease.source
                : 'unavailable',
            version: typeof updaterStatus.latestRelease?.version === 'string' ? updaterStatus.latestRelease.version : null,
          },
          mode: this.config.updates.mode,
          serviceAvailable: true,
          track: {
            currentBranch: typeof track?.currentBranch === 'string' ? track.currentBranch : null,
            currentCommit: typeof track?.currentCommit === 'string' ? track.currentCommit : null,
            label: typeof track?.label === 'string' ? track.label : null,
            ref: typeof track?.ref === 'string' ? track.ref : null,
            type: track?.type === 'branch' || track?.type === 'stable' ? track.type : null,
          },
          updateAvailable: updaterStatus.updateAvailable === true,
        };
      } catch (caughtError) {
        const fallback = await this.getFallbackStatus();
        return {
          ...fallback,
          currentJob: null,
          error: caughtError instanceof Error ? caughtError.message : 'Managed update agent is unavailable.',
          serviceAvailable: false,
        };
      }
    }

    const fallback = await this.getFallbackStatus();
    return {
      ...fallback,
      currentJob: null,
      serviceAvailable: false,
    };
  }

  async startManagedUpdate(): Promise<{ job: Record<string, unknown> }> {
    return startAgentUpdate(this.config, {
      initiator: this.config.ownerEmail,
      target: 'latest',
    });
  }

  private async getFallbackStatus(): Promise<Omit<UpdateStatus, 'currentJob' | 'serviceAvailable'>> {
    const checkedAt = new Date().toISOString();
    const installed = readInstalledVersion();
    const localManifest = readLocalReleaseManifest();

    let latestRelease = {
      channel: localManifest?.channel || null,
      notesUrl: localManifest?.notesUrl || null,
      publishedAt: localManifest?.publishedAt || null,
      source: (localManifest ? 'local-manifest' : 'unavailable') as ReleaseSource,
      version: localManifest?.version || null,
    };
    let error: string | null = null;

    const overrideRelease = buildOverrideRelease(this.config);
    if (overrideRelease) {
      latestRelease = {
        channel: overrideRelease.channel,
        notesUrl: overrideRelease.notesUrl || null,
        publishedAt: overrideRelease.publishedAt || null,
        source: 'override',
        version: overrideRelease.version,
      };
    } else {
      try {
        const githubRelease = await readLatestGitHubRelease(this.config);
        if (githubRelease) {
          latestRelease = {
            channel: githubRelease.channel,
            notesUrl: githubRelease.notesUrl || null,
            publishedAt: githubRelease.publishedAt || null,
            source: 'github-release',
            version: githubRelease.version,
          };
        }
      } catch (caughtError) {
        error = caughtError instanceof Error ? caughtError.message : 'Unable to check GitHub releases.';
      }
    }

    return {
      checkedAt,
      error,
      installedVersion: installed.version,
      installedVersionSource: installed.source,
      latestRelease,
      mode: this.config.updates.mode,
      track: {
        currentBranch: null,
        currentCommit: null,
        label: this.config.updates.mode === 'managed' ? 'Managed install' : 'Stable releases',
        ref: null,
        type: null,
      },
      updateAvailable: compareVersions(installed.version, latestRelease.version) < 0,
    };
  }
}
