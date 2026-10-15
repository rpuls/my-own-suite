const { requestAgent } = require('../agent-request.cjs');

const BACKUP_AGENT_TIMEOUT_MS = 180_000;

class BackupAgentClient {
  constructor({ socketPath = process.env.MOS_BACKUP_AGENT_SOCKET || '/run/mos-backup-agent/agent.sock', timeoutMs = BACKUP_AGENT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async request(method, requestPath, body) {
    const answer = await requestAgent({ body, method, path: requestPath, socketPath: this.socketPath, timeoutMs: this.timeoutMs }).catch(() => {
      throw Object.assign(new Error('Backup system agent is unavailable.'), {
        code: 'BACKUP_AGENT_UNAVAILABLE',
        statusCode: 503,
      });
    });
    if (answer.ok) return answer.body;
    throw Object.assign(new Error(answer.body.error || 'Backup agent rejected the operation.'), {
      code: answer.body.code || 'BACKUP_AGENT_REJECTED',
      statusCode: answer.statusCode,
    });
  }

  status() { return this.request('GET', '/v1/status'); }
  // The current job and the schedule alone. A full status lists every drive and
  // reaches every connected bucket, which is far more than a caller polling for
  // "is a backup running" needs.
  summary() { return this.request('GET', '/v1/summary'); }
  job(id) { return this.request('GET', `/v1/jobs/${encodeURIComponent(id)}`); }
  mount(destinationId) { return this.request('POST', '/v1/destinations/mount', { destinationId }); }
  connectObjectDestination(input) { return this.request('POST', '/v1/destinations/object', input); }
  disconnectObjectDestination(input) { return this.request('POST', '/v1/destinations/object/remove', input); }
  testObjectDestination(input) { return this.request('POST', '/v1/destinations/object/test', input); }
  startBackup(input) { return this.request('POST', '/v1/backups', input); }
  validateBackup(input) { return this.request('POST', '/v1/backups/validate', input); }
  deleteBackup(input) { return this.request('POST', '/v1/backups/delete', input); }
  setBackupNote(input) { return this.request('POST', '/v1/backups/note', input); }
  setSchedule(input) { return this.request('POST', '/v1/schedule', input); }
  setPrimaryDestination(input) { return this.request('POST', '/v1/destinations/primary', input); }
  startRestore(input) { return this.request('POST', '/v1/restores', input); }
  acknowledgeInterruptedRestore(input) { return this.request('POST', '/v1/restores/acknowledge-interruption', input); }
  recoveryKeyStatus() { return this.request('GET', '/v1/recovery-key'); }
  acknowledgeRecoveryKey() { return this.request('POST', '/v1/recovery-key/acknowledge', {}); }
  revealRecoveryKey() { return this.request('POST', '/v1/recovery-key/reveal', {}); }
  // Replaces the key on this server's disk and on every archive it can reach,
  // and hands back the new one exactly once, the same way the first one was
  // handed over.
  rotateRecoveryKey() { return this.request('POST', '/v1/recovery-key/rotate', {}); }
  unlockDestination(input) { return this.request('POST', '/v1/destinations/unlock', input); }
  forgetDestinationKey(destinationId) { return this.request('POST', '/v1/destinations/forget-key', { destinationId }); }
  // Stops MOS remembering a drive it is not holding. Nothing on the drive is
  // touched: it is not here.
  forgetDrive(fsUuid) { return this.request('POST', '/v1/destinations/forget-drive', { fsUuid }); }
  archiveKeys(input) { return this.request('POST', '/v1/destinations/keys', input); }
  removeArchiveKey(input) { return this.request('POST', '/v1/destinations/keys/remove', input); }
}

module.exports = { BackupAgentClient };
