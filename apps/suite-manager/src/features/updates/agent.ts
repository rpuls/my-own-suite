import fs from 'node:fs';
import http from 'node:http';

import type { SuiteManagerConfig } from '../../config.ts';

type AgentJobSummary = {
  id: string;
  logs?: Array<{ at?: string; message?: string }>;
  stage: string | null;
  status: string | null;
  target: string | null;
  updatedAt: string | null;
};

type AgentStatusPayload = {
  currentJob: AgentJobSummary | null;
  lastJob: AgentJobSummary | null;
  repoDir: string;
  service: string;
  socketPath: string;
  updaterStatus: Record<string, unknown>;
};

function loadToken(config: SuiteManagerConfig): string {
  if (!config.updates.agentTokenFile) {
    return '';
  }

  try {
    return fs.readFileSync(config.updates.agentTokenFile, 'utf8').trim();
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
        socketPath: config.updates.agentSocketPath,
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
                  : `Agent request failed with status ${response.statusCode}.`,
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
      request.destroy(new Error('Agent request timed out.'));
    });

    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

export async function readAgentStatus(config: SuiteManagerConfig): Promise<AgentStatusPayload> {
  return requestAgent<AgentStatusPayload>(config, 'GET', '/v1/status');
}

export async function startAgentUpdate(
  config: SuiteManagerConfig,
  payload: { initiator: string; target: string },
): Promise<{ job: Record<string, unknown> }> {
  return requestAgent<{ job: Record<string, unknown> }>(config, 'POST', '/v1/jobs', payload);
}
