import fs from 'node:fs';
import http from 'node:http';

import type { SuiteManagerConfig } from '../../config.ts';

export type BackupAgentJobSummary = {
  backupPath: string | null;
  destinationId: string | null;
  error: string | null;
  id: string;
  kind: string | null;
  logs?: Array<{ at?: string; message?: string }>;
  outputPath: string | null;
  stage: string | null;
  status: string | null;
  updatedAt: string | null;
};

export type BackupAgentDestination = {
  availableBytes: number | null;
  id: string;
  label: string;
  mountPath: string;
  sizeBytes: number | null;
  transport: string | null;
  writable: boolean;
};

export type BackupAgentBundle = {
  activeProfiles: string[];
  createdAt: string | null;
  destinationId: string;
  destinationLabel: string;
  id: string;
  path: string;
  schemaVersion: number | null;
  sourceCommit: string | null;
  sourceVersion: string | null;
  totalVolumeArchiveBytes: number;
  volumeCount: number;
};

export type BackupAgentStatusPayload = {
  backups?: BackupAgentBundle[];
  capabilities?: Record<string, { capabilities?: string[] } | string[]>;
  currentJob: BackupAgentJobSummary | null;
  destinations?: BackupAgentDestination[];
  lastJob: BackupAgentJobSummary | null;
  repoDir?: string;
  service?: string;
  socketPath?: string;
};

function loadToken(config: SuiteManagerConfig): string {
  if (!config.backupAgent.tokenFile) {
    return '';
  }

  try {
    return fs.readFileSync(config.backupAgent.tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function requestAgent<T>(
  config: SuiteManagerConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const token = loadToken(config);
    const headers: Record<string, string | number> = {};

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let payload: string | null = null;
    if (body) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = http.request(
      {
        headers,
        method,
        path,
        socketPath: config.backupAgent.socketPath,
        timeout: config.requestTimeoutMs,
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = raw.trim() ? (JSON.parse(raw) as T | { error?: string }) : ({} as T);
            if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
              resolve(parsed as T);
              return;
            }

            reject(
              new Error(
                'error' in parsed && typeof parsed.error === 'string'
                  ? parsed.error
                  : `Backup-agent request failed with status ${response.statusCode}.`,
              ),
            );
          } catch (caughtError) {
            reject(caughtError);
          }
        });
      },
    );

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('Backup-agent request timed out.'));
    });

    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

export async function readBackupAgentStatus(config: SuiteManagerConfig): Promise<BackupAgentStatusPayload> {
  return requestAgent<BackupAgentStatusPayload>(config, 'GET', '/v1/status');
}

export async function startAgentBackup(
  config: SuiteManagerConfig,
  payload: { destinationId: string; initiator: string },
): Promise<{ job: Record<string, unknown> }> {
  return requestAgent<{ job: Record<string, unknown> }>(config, 'POST', '/v1/jobs', payload);
}

export async function startAgentRestore(
  config: SuiteManagerConfig,
  payload: { backupPath: string; confirmation: string; initiator: string },
): Promise<{ job: Record<string, unknown> }> {
  return requestAgent<{ job: Record<string, unknown> }>(config, 'POST', '/v1/restores', payload);
}
