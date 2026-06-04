import fs from 'node:fs';
import http from 'node:http';

import type { SuiteManagerConfig } from '../../config.ts';

type ServiceAgentStatusPayload = {
  capabilities?: Record<string, { capabilities?: string[]; container?: string }>;
  service?: string;
  socketPath?: string;
};

function loadToken(config: SuiteManagerConfig): string {
  if (!config.serviceAgent.tokenFile) {
    return '';
  }

  try {
    return fs.readFileSync(config.serviceAgent.tokenFile, 'utf8').trim();
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
    const headers: Record<string, string> = {};
    const requestBody = body ? JSON.stringify(body) : null;

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (requestBody) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(requestBody));
    }

    const request = http.request(
      {
        headers,
        method,
        path,
        socketPath: config.serviceAgent.socketPath,
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
                  : `Service-agent request failed with status ${response.statusCode}.`,
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
      request.destroy(new Error('Service-agent request timed out.'));
    });
    if (requestBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

export async function readServiceAgentStatus(config: SuiteManagerConfig): Promise<ServiceAgentStatusPayload> {
  return requestAgent<ServiceAgentStatusPayload>(config, 'GET', '/v1/status');
}

export async function restartAgentService(
  config: SuiteManagerConfig,
  serviceName: string,
): Promise<{ ok?: boolean; service?: string }> {
  return requestAgent<{ ok?: boolean; service?: string }>(
    config,
    'POST',
    `/v1/services/${encodeURIComponent(serviceName)}/restart`,
  );
}

export async function applyAgentCaddyExternalProxies(
  config: SuiteManagerConfig,
  caddyfile: string,
): Promise<{ ok?: boolean; service?: string }> {
  return requestAgent<{ ok?: boolean; service?: string }>(
    config,
    'POST',
    '/v1/caddy/external-proxies/apply',
    { caddyfile },
  );
}

export async function applyAgentLocalHttps(
  config: SuiteManagerConfig,
  input: { acmeEmail: string; cloudflareApiToken: string; domain: string },
): Promise<{ domain?: string; ok?: boolean; restartScheduled?: boolean }> {
  return requestAgent<{ domain?: string; ok?: boolean; restartScheduled?: boolean }>(
    config,
    'POST',
    '/v1/settings/local-https/apply',
    input,
  );
}
