const { buildOperationDiagnostics } = require('../diagnostics/operation-diagnostics.cjs');

// The update agent already trims a failed step's output to its last lines;
// this is the ceiling on what a status poll carries should that ever change.
const OUTPUT_LIMIT_CHARS = 20_000;

function capabilityAvailable(capabilities, resource, capability) {
  return capabilities?.[resource]?.capabilities?.includes(capability) === true;
}

// The backup taken before the apply, as job state rather than a log line: an
// owner who reloads while it is waiting still has to see which restore point is
// being taken and what it is waiting for.
function normalizeCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  const waiting = checkpoint.waiting && typeof checkpoint.waiting.reason === 'string' ? checkpoint.waiting : null;
  return {
    backupId: typeof checkpoint.backupId === 'string' ? checkpoint.backupId : null,
    jobId: typeof checkpoint.jobId === 'string' ? checkpoint.jobId : null,
    status: typeof checkpoint.status === 'string' ? checkpoint.status : null,
    target: typeof checkpoint.target === 'string' ? checkpoint.target : null,
    waiting: waiting ? { reason: waiting.reason, since: typeof waiting.since === 'string' ? waiting.since : null } : null,
  };
}

function normalizeJob(job) {
  if (!job) return null;
  return {
    checkpoint: normalizeCheckpoint(job.checkpoint),
    completedAt: typeof job.completedAt === 'string' ? job.completedAt : null,
    error: typeof job.error === 'string' ? job.error : null,
    id: typeof job.id === 'string' ? job.id : '',
    logs: Array.isArray(job.logs) ? job.logs.filter((entry) => entry && typeof entry.message === 'string').slice(-30) : [],
    output: typeof job.output === 'string' && job.output ? job.output.slice(-OUTPUT_LIMIT_CHARS) : null,
    stage: typeof job.stage === 'string' ? job.stage : null,
    status: typeof job.status === 'string' ? job.status : null,
    target: typeof job.target === 'string' ? job.target : null,
    updatedAt: typeof job.updatedAt === 'string' ? job.updatedAt : null,
  };
}

// A check that could not be completed, with what the agent found out about
// why. The text is bounded and redacted here for the same reason an app
// operation's is: it ends up in the diagnostics bundle.
function normalizeCheckFailure(checkFailure) {
  if (!checkFailure || typeof checkFailure.reason !== 'string' || !checkFailure.reason) return null;
  const { diagnostics, errorCode } = buildOperationDiagnostics(
    { code: 'UPDATE_CHECK_FAILED', details: checkFailure.details, message: checkFailure.reason },
  );
  return { diagnostics, errorCode, reason: checkFailure.reason };
}

// Where the backup before an update would go, so the Updates screen can say so
// before the click — or say that there is nowhere.
function normalizeCheckpointSettings(agentPayload, summary) {
  const primary = summary?.primaryDestination || null;
  return {
    destinationLabel: typeof primary?.label === 'string' ? primary.label : null,
    ready: Boolean(primary?.destinationId),
    supported: capabilityAvailable(agentPayload?.capabilities, 'updates', 'checkpoint'),
  };
}

const HOST_PACKAGE_LIST_LIMIT = 200;
const HOST_DIAGNOSTICS_LIMIT_CHARS = 20_000;

function nameList(value, limit = HOST_PACKAGE_LIST_LIMIT) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').slice(0, limit) : [];
}

// What the post-patch check decided, if it has run. `ok` is three-valued for the
// same reason `updateAvailable` is: a check that could not run is neither a
// suite that came back nor one that did not.
function normalizeHostHealth(health) {
  if (!health || typeof health !== 'object') return null;
  return {
    at: typeof health.at === 'string' ? health.at : null,
    failures: Array.isArray(health.failures)
      ? health.failures.slice(0, 20).map((failure) => ({
        active: typeof failure?.active === 'string' ? failure.active : 'unknown',
        name: typeof failure?.name === 'string' ? failure.name : 'unknown unit',
        sub: typeof failure?.sub === 'string' ? failure.sub : 'unknown',
      }))
      : [],
    ok: health.ok === true ? true : health.ok === false ? false : null,
    reason: typeof health.reason === 'string' ? health.reason : null,
  };
}

// The one sentence the Updates screen leads with, for a server whose state was
// read and one whose state was not: nothing waiting and nothing known are
// different answers.
function summarizeHostPatches(state) {
  if (!state || state.available === false) return 'Ubuntu patch state could not be read on this server.';
  if (state.managedBy === 'owner') return 'You manage Ubuntu’s automatic updates on this server. MOS reports what it found and changes nothing.';
  if (state.managedBy === 'none') return 'Ubuntu security updates are not being applied automatically on this server.';
  const waiting = state.security?.length || 0;
  if (waiting === 0) return 'No Ubuntu security updates are waiting.';
  return waiting === 1
    ? 'One Ubuntu security update is waiting and installs on its own.'
    : `${waiting} Ubuntu security updates are waiting and install on their own.`;
}

// Ubuntu's own patch state, read through the read-only diagnostics agent. A
// server whose agent does not answer reports that it could not be read, which is
// the honest answer and is not the same as a server with nothing pending.
function normalizeHostPatches(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      available: false, allowedOrigins: [], automaticReboot: null, checkedAt: null, diagnostics: null,
      health: null, heldPackages: [], lastInstallAt: null, lastInstalledPackages: [], lastRunAt: null,
      managedBy: 'unknown', managedReason: null, otherCount: 0, rebootPackages: [], rebootRequired: false,
      security: [], securityCount: 0, summary: summarizeHostPatches(null),
    };
  }
  const security = nameList(payload.security);
  const state = {
    allowedOrigins: nameList(payload.allowedOrigins, 20),
    automaticReboot: payload.automaticReboot === true ? true : payload.automaticReboot === false ? false : null,
    available: payload.available === true,
    checkedAt: typeof payload.lastListedAt === 'string' ? payload.lastListedAt : null,
    health: normalizeHostHealth(payload.health),
    heldPackages: nameList(payload.heldPackages, 50),
    lastInstallAt: typeof payload.lastInstallAt === 'string' ? payload.lastInstallAt : null,
    lastInstalledPackages: nameList(payload.lastInstalledPackages),
    lastRunAt: typeof payload.lastRunAt === 'string' ? payload.lastRunAt : null,
    managedBy: ['mos', 'none', 'owner'].includes(payload.managedBy) ? payload.managedBy : 'unknown',
    managedReason: typeof payload.managedReason === 'string' ? payload.managedReason : null,
    otherCount: Array.isArray(payload.other) ? payload.other.length : 0,
    rebootPackages: nameList(payload.rebootPackages, 50),
    rebootRequired: payload.rebootRequired === true,
    security,
    securityCount: security.length,
  };
  // The evidence behind every number above, in one block, so what an owner
  // pastes into a bug report is what the screen was reading.
  const diagnostics = [
    payload.simulation ? `apt-get --just-print dist-upgrade:\n${payload.simulation}` : '',
    state.allowedOrigins.length ? `Allowed-Origins: ${state.allowedOrigins.join(', ')}` : '',
    state.heldPackages.length ? `Package-Blacklist: ${state.heldPackages.join(', ')}` : '',
    payload.unattendedLog ? `unattended-upgrades.log:\n${payload.unattendedLog}` : '',
  ].filter(Boolean).join('\n\n');
  return { ...state, diagnostics: diagnostics ? diagnostics.slice(-HOST_DIAGNOSTICS_LIMIT_CHARS) : null, summary: summarizeHostPatches(payload) };
}

// updateAvailable is three-valued: null means the last check did not
// complete, which is neither "up to date" nor "an update is waiting".
function normalizeStatus(agentPayload, serviceAvailable, summary = null, hostPatches = null) {
  const updaterStatus = agentPayload?.updaterStatus || {};
  const track = updaterStatus.track || {};
  const latestRelease = updaterStatus.latestRelease || {};
  const checkFailure = normalizeCheckFailure(updaterStatus.checkFailure);
  return {
    changeSummary: {
      items: Array.isArray(updaterStatus.changeSummary?.items)
        ? updaterStatus.changeSummary.items.filter((item) => typeof item === 'string').slice(0, 6)
        : [],
      source: typeof updaterStatus.changeSummary?.source === 'string' ? updaterStatus.changeSummary.source : null,
      title: typeof updaterStatus.changeSummary?.title === 'string' ? updaterStatus.changeSummary.title : 'Changes in this update',
    },
    checkFailure,
    checkedAt: typeof updaterStatus.checkedAt === 'string' ? updaterStatus.checkedAt : new Date().toISOString(),
    checkpoint: normalizeCheckpointSettings(agentPayload, summary),
    currentJob: normalizeJob(agentPayload?.currentJob),
    host: normalizeHostPatches(hostPatches),
    installedVersion: typeof updaterStatus.installedVersion === 'string' ? updaterStatus.installedVersion : null,
    latestRelease: {
      channel: typeof latestRelease.channel === 'string' ? latestRelease.channel : null,
      notesUrl: typeof latestRelease.notesUrl === 'string' ? latestRelease.notesUrl : null,
      publishedAt: typeof latestRelease.publishedAt === 'string' ? latestRelease.publishedAt : null,
      source: typeof latestRelease.source === 'string' ? latestRelease.source : null,
      version: typeof latestRelease.version === 'string' ? latestRelease.version : null,
    },
    latestRevision: typeof updaterStatus.latestRevision === 'string' ? updaterStatus.latestRevision : null,
    managedApplyAvailable: capabilityAvailable(agentPayload?.capabilities, 'updates', 'apply'),
    serviceAvailable,
    track: {
      currentBranch: typeof track.currentBranch === 'string' ? track.currentBranch : null,
      currentCommit: typeof track.currentCommit === 'string' ? track.currentCommit : null,
      label: typeof track.label === 'string' ? track.label : null,
      ref: typeof track.ref === 'string' ? track.ref : null,
      type: track.type === 'branch' || track.type === 'stable' ? track.type : null,
    },
    trackConfigurationAvailable: capabilityAvailable(agentPayload?.capabilities, 'updates', 'configure-track'),
    updateAvailable: checkFailure ? null : updaterStatus.updateAvailable === true ? true : updaterStatus.updateAvailable === false ? false : null,
  };
}

function requiredJobId(input, verb) {
  const id = String(input.id || '').trim();
  if (id) return id;
  const error = new Error(`Choose the update to ${verb}.`);
  error.statusCode = 400;
  throw error;
}

class UpdateService {
  constructor({ agent, backupAgent = null, diagnosticsAgent = null }) {
    this.agent = agent;
    this.backupAgent = backupAgent;
    // The read-only agent, for the host's own patch state. The Updates screen
    // reports MOS, the apps and Ubuntu in one place because that is where an
    // owner already looks to ask whether their server is current.
    this.diagnosticsAgent = diagnosticsAgent;
  }

  // Ubuntu patch state, or nothing. A diagnostics agent that does not answer
  // must not take the Updates screen down with it: the MOS half of this page is
  // what an owner came for, and the host half says it could not be read.
  async hostPatches() {
    if (!this.diagnosticsAgent) return null;
    try {
      return await this.diagnosticsAgent.hostPatches();
    } catch {
      return null;
    }
  }

  // The cheap read on the backup agent: the schedule and whatever job is
  // running. A backup agent that does not answer leaves the Updates screen
  // saying no checkpoint will be taken, which is what would happen.
  async backupSummary() {
    if (!this.backupAgent) return null;
    try {
      return await this.backupAgent.summary();
    } catch {
      return null;
    }
  }

  async status() {
    const hostPatches = await this.hostPatches();
    try {
      const [agentPayload, summary] = await Promise.all([this.agent.status(), this.backupSummary()]);
      return normalizeStatus(agentPayload, true, summary, hostPatches);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Update system agent is unavailable.';
      return normalizeStatus({
        updaterStatus: {
          checkFailure: { details: [], reason },
          checkedAt: new Date().toISOString(),
          error: reason,
          updateAvailable: null,
        },
      }, false, null, hostPatches);
    }
  }

  // The restart a patched kernel needs. MOS said one was needed, so MOS performs
  // it; the owner confirmed it in the browser. Whether one is needed at all, and
  // whether an update or a backup is mid-write, is the privileged agent's own
  // check, and it answers by refusing.
  restartHost() {
    return this.agent.restartHost();
  }

  async start(input = {}) {
    const status = await this.status();
    if (!status.managedApplyAvailable) {
      const error = new Error('Managed update apply is unavailable on this install.');
      error.statusCode = 503;
      throw error;
    }
    if (status.currentJob && (status.currentJob.status === 'queued' || status.currentJob.status === 'running')) {
      const error = new Error('An update job is already running.');
      error.statusCode = 409;
      throw error;
    }
    if (status.updateAvailable === null) {
      const error = new Error(`Could not check for updates: ${status.checkFailure?.reason || 'the last check did not complete.'}`);
      error.statusCode = 409;
      throw error;
    }
    if (!status.updateAvailable) {
      const error = new Error('This machine is already up to date on its current track.');
      error.statusCode = 409;
      throw error;
    }
    // The agent refuses to begin on top of backup work, naming what is
    // running; that sentence reaches the owner as it is.
    return this.agent.startUpdate({ initiator: input.initiator || 'owner', target: 'latest' });
  }

  // The two answers an owner can give while an update waits for its backup.
  // The agent enforces when each is still possible, because it is what knows
  // how far the apply has gone.
  async cancel(input = {}) {
    await this.agent.cancelUpdate(requiredJobId(input, 'cancel'));
    return this.status();
  }

  async skipBackup(input = {}) {
    await this.agent.skipBackup(requiredJobId(input, 'update without a backup'));
    return this.status();
  }

  async configureTrack(input = {}) {
    const status = await this.status();
    if (!status.trackConfigurationAvailable) {
      const error = new Error('Update track switching is unavailable on this install.');
      error.statusCode = 503;
      throw error;
    }
    if (status.currentJob && (status.currentJob.status === 'queued' || status.currentJob.status === 'running')) {
      const error = new Error('Wait for the current update job to finish before switching tracks.');
      error.statusCode = 409;
      throw error;
    }
    const trackId = input.track === 'stable' ? 'stable' : input.track === 'staging' ? 'staging' : 'main';
    await this.agent.configureTrack(trackId === 'stable'
      ? { ref: 'main', track: 'stable' }
      : { ref: trackId, track: 'branch' });
    return this.status();
  }
}

module.exports = { UpdateService, normalizeHostPatches, normalizeStatus };
