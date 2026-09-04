const { buildOperationDiagnostics } = require('../diagnostics/operation-diagnostics.cjs');

// The update agent already trims a failed step's output to its last lines;
// this is the ceiling on what a status poll carries should that ever change.
const OUTPUT_LIMIT_CHARS = 20_000;

function capabilityAvailable(capabilities, resource, capability) {
  const value = capabilities?.[resource];
  if (Array.isArray(value)) return value.includes(capability);
  return value?.capabilities?.includes(capability) === true;
}

function normalizeJob(job) {
  if (!job) return null;
  return {
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

// updateAvailable is three-valued: null means the last check did not
// complete, which is neither "up to date" nor "an update is waiting".
function normalizeStatus(agentPayload, serviceAvailable) {
  const updaterStatus = agentPayload?.updaterStatus || {};
  const track = updaterStatus.track || {};
  const latestRelease = updaterStatus.latestRelease || {};
  const checkFailure = normalizeCheckFailure(updaterStatus.checkFailure
    || (typeof updaterStatus.error === 'string' && updaterStatus.error ? { details: [], reason: updaterStatus.error } : null));
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
    currentJob: normalizeJob(agentPayload?.currentJob),
    error: typeof updaterStatus.error === 'string' ? updaterStatus.error : null,
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

class UpdateService {
  constructor({ agent }) {
    this.agent = agent;
  }

  async status() {
    try {
      return normalizeStatus(await this.agent.status(), true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Update system agent is unavailable.';
      return normalizeStatus({
        updaterStatus: {
          checkFailure: { details: [], reason },
          checkedAt: new Date().toISOString(),
          error: reason,
          updateAvailable: null,
        },
      }, false);
    }
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
    return this.agent.startUpdate({ initiator: input.initiator || 'owner', target: 'latest' });
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

module.exports = { UpdateService, normalizeStatus };
