const http = require('node:http');

const BACKUP_AGENT_TIMEOUT_MS = 180_000;

class BackupAgentClient {
  constructor({ socketPath = process.env.MOS_BACKUP_AGENT_SOCKET || '/run/mos-backup-agent/agent.sock', timeoutMs = BACKUP_AGENT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  settleResponse(response, resolve, reject) {
    let raw = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { raw += chunk; });
    response.on('end', () => {
      let parsed = {};
      try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch {}
      if (response.statusCode >= 200 && response.statusCode < 300) {
        resolve(parsed);
        return;
      }
      const error = new Error(parsed.error || 'Backup agent rejected the operation.');
      error.code = parsed.code || 'BACKUP_AGENT_REJECTED';
      error.statusCode = response.statusCode;
      reject(error);
    });
  }

  request(method, requestPath, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const request = http.request({
        headers: payload ? { 'Content-Length': Buffer.byteLength(payload), 'Content-Type': 'application/json' } : {},
        method,
        path: requestPath,
        socketPath: this.socketPath,
        timeout: this.timeoutMs,
      }, (response) => this.settleResponse(response, resolve, reject));
      request.on('error', () => {
        const error = new Error('Backup system agent is unavailable.');
        error.code = 'BACKUP_AGENT_UNAVAILABLE';
        error.statusCode = 503;
        reject(error);
      });
      request.on('timeout', () => request.destroy(new Error('BACKUP_AGENT_TIMEOUT')));
      if (payload) request.write(payload);
      request.end();
    });
  }

  // Streams an uploaded bundle archive through to the agent unchanged. The
  // long timeout is deliberate: a multi-gigabyte upload over the LAN is a
  // normal recovery flow, not a hung request.
  uploadBackup(sourceStream, { contentLength, destinationId }) {
    return new Promise((resolve, reject) => {
      const request = http.request({
        headers: { 'Content-Length': contentLength, 'Content-Type': 'application/octet-stream' },
        method: 'POST',
        path: `/v1/backups/upload?destinationId=${encodeURIComponent(destinationId)}`,
        socketPath: this.socketPath,
        timeout: 3_600_000,
      }, (response) => this.settleResponse(response, resolve, reject));
      request.on('error', () => {
        const error = new Error('Backup system agent is unavailable.');
        error.code = 'BACKUP_AGENT_UNAVAILABLE';
        error.statusCode = 503;
        reject(error);
      });
      request.on('timeout', () => request.destroy(new Error('BACKUP_AGENT_TIMEOUT')));
      sourceStream.on('error', () => request.destroy(new Error('UPLOAD_STREAM_ERROR')));
      sourceStream.pipe(request);
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  mount(destinationId) { return this.request('POST', '/v1/destinations/mount', { destinationId }); }
  startBackup(input) { return this.request('POST', '/v1/backups', input); }
  validateBackup(input) { return this.request('POST', '/v1/backups/validate', input); }
  deleteBackup(input) { return this.request('POST', '/v1/backups/delete', input); }
  setBackupNote(input) { return this.request('POST', '/v1/backups/note', input); }
  startRestore(input) { return this.request('POST', '/v1/restores', input); }
  acknowledgeInterruptedRestore(input) { return this.request('POST', '/v1/restores/acknowledge-interruption', input); }
}

module.exports = { BACKUP_AGENT_TIMEOUT_MS, BackupAgentClient };
