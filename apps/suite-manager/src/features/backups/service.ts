import type { SuiteManagerConfig } from '../../config.ts';
import {
  readBackupAgentStatus,
  startAgentBackup,
  startAgentRestore,
  type BackupAgentBundle,
  type BackupAgentDestination,
  type BackupAgentJobSummary,
} from './agent.ts';

export type BackupsStatus = {
  checkedAt: string;
  backups: BackupAgentBundle[];
  currentJob: BackupAgentJobSummary | null;
  destinations: BackupAgentDestination[];
  error: string | null;
  lastJob: BackupAgentJobSummary | null;
  restorePlanAvailable: boolean;
  restoreApplyAvailable: boolean;
  serviceAvailable: boolean;
  startBackupAvailable: boolean;
};

function hasAgentCapability(
  capabilities: Record<string, { capabilities?: string[] } | string[]> | undefined,
  resourceName: string,
  capabilityName: string,
): boolean {
  const resourceCapabilities = capabilities?.[resourceName];

  if (Array.isArray(resourceCapabilities)) {
    return resourceCapabilities.includes(capabilityName);
  }

  return resourceCapabilities?.capabilities?.includes(capabilityName) === true;
}

function isRunning(job: BackupAgentJobSummary | null): boolean {
  return Boolean(job && (job.status === 'running' || job.status === 'queued'));
}

export class BackupsService {
  private readonly config: SuiteManagerConfig;

  constructor(config: SuiteManagerConfig) {
    this.config = config;
  }

  async getStatus(): Promise<BackupsStatus> {
    if (!this.config.backupAgent.socketPath || !this.config.backupAgent.tokenFile) {
      return {
        checkedAt: new Date().toISOString(),
        backups: [],
        currentJob: null,
        destinations: [],
        error: null,
        lastJob: null,
        restorePlanAvailable: false,
        restoreApplyAvailable: false,
        serviceAvailable: false,
        startBackupAvailable: false,
      };
    }

    try {
      const agent = await readBackupAgentStatus(this.config);
      return {
        checkedAt: new Date().toISOString(),
        backups: Array.isArray(agent.backups) ? agent.backups : [],
        currentJob: agent.currentJob,
        destinations: Array.isArray(agent.destinations) ? agent.destinations : [],
        error: null,
        lastJob: agent.lastJob,
        restorePlanAvailable: hasAgentCapability(agent.capabilities, 'restores', 'plan'),
        restoreApplyAvailable: hasAgentCapability(agent.capabilities, 'restores', 'apply'),
        serviceAvailable: true,
        startBackupAvailable: hasAgentCapability(agent.capabilities, 'backups', 'create'),
      };
    } catch (caughtError) {
      return {
        checkedAt: new Date().toISOString(),
        backups: [],
        currentJob: null,
        destinations: [],
        error: caughtError instanceof Error ? caughtError.message : 'Backup agent is unavailable.',
        lastJob: null,
        restorePlanAvailable: false,
        restoreApplyAvailable: false,
        serviceAvailable: false,
        startBackupAvailable: false,
      };
    }
  }

  async startBackup(destinationId: string): Promise<{ job: Record<string, unknown> }> {
    const status = await this.getStatus();
    if (!status.startBackupAvailable) {
      throw new Error('Managed backup capability is unavailable.');
    }

    if (isRunning(status.currentJob)) {
      throw new Error('A backup job is already running.');
    }

    const destination = status.destinations.find((candidate) => candidate.id === destinationId);
    if (!destination) {
      throw new Error('Selected backup destination is no longer available.');
    }

    if (!destination.writable) {
      throw new Error('Selected backup destination is not writable.');
    }

    return startAgentBackup(this.config, {
      destinationId,
      initiator: this.config.ownerEmail,
    });
  }

  async startRestore(backupPath: string, confirmation: string): Promise<{ job: Record<string, unknown> }> {
    const status = await this.getStatus();
    if (!status.restoreApplyAvailable) {
      throw new Error('Managed restore capability is unavailable.');
    }

    if (isRunning(status.currentJob)) {
      throw new Error('A backup or restore job is already running.');
    }

    const backup = status.backups.find((candidate) => candidate.path === backupPath);
    if (!backup) {
      throw new Error('Selected backup bundle is no longer available.');
    }

    if (confirmation !== 'RESTORE') {
      throw new Error('Type RESTORE to confirm this destructive restore.');
    }

    return startAgentRestore(this.config, {
      backupPath,
      confirmation,
      initiator: this.config.ownerEmail,
    });
  }
}
