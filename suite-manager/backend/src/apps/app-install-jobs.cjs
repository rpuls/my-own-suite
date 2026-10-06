const { AppJobs } = require('./app-jobs.cjs');

// An install that ends with the app started but missing from Homepage is the
// failure a page-driven install used to leave behind.
class AppInstallJobs extends AppJobs {
  constructor({ addToHomepage, logger = null, now, prepare, progressOf, start, waitForAddress }) {
    super({ busyMessage: 'This app is already being installed.', failureCode: 'APP_INSTALL_FAILED', failureEvent: 'app-install-failed', logger, now });
    this.addToHomepage = addToHomepage;
    this.prepare = prepare;
    this.progressOf = progressOf;
    this.start = start;
    this.waitForAddress = waitForAddress;
  }

  begin(packageId, { config = {}, showOnHomepage = false } = {}) {
    return super.begin(packageId, { config, showOnHomepage });
  }

  stepsFor({ showOnHomepage }) {
    return ['prepare', 'runtime', 'address', ...(showOnHomepage ? ['homepage'] : []), 'ready'];
  }

  async perform(packageId, { config, showOnHomepage }, mark) {
    mark('prepare', 'running');
    const skipPrepare = this.progressOf(packageId).installed;
    await this.prepare(packageId, config);
    mark('prepare', skipPrepare ? 'skipped' : 'complete');

    mark('runtime', 'running');
    const skipRuntime = this.progressOf(packageId).runtimeApplied;
    if (!skipRuntime) await this.start(packageId);
    mark('runtime', skipRuntime ? 'skipped' : 'complete');

    // A late address is not a failed install: the app runs, and Caddy keeps asking for the certificate.
    mark('address', 'running');
    const address = await this.waitForAddress(packageId);
    mark('address', 'complete');

    if (showOnHomepage) {
      mark('homepage', 'running');
      const skipHomepage = this.progressOf(packageId).homepageApplied;
      if (!skipHomepage) await this.addToHomepage(packageId);
      mark('homepage', skipHomepage ? 'skipped' : 'complete');
    }

    mark('ready', 'complete');
    if (address.status === 'ready') return {};
    return { notice: addressNotice(address), resolved: this.addressOpens(packageId) };
  }

  async addressOpens(packageId) {
    for (let round = 0; round < ADDRESS_FOLLOW_UP_ROUNDS; round += 1) {
      if ((await this.waitForAddress(packageId)).status === 'ready') return true;
    }
    return false;
  }
}

// Each round is the agent's own five-minute wait, so the notice is rechecked for half an hour.
const ADDRESS_FOLLOW_UP_ROUNDS = 6;

function addressNotice({ awaiting, lastProbe, publicUrl }) {
  const host = new URL(publicUrl).host;
  const message = awaiting === 'certificate'
    ? `${host} does not open yet because its certificate has not arrived. The app is installed and running, and the address opens as soon as the certificate does; MOS keeps asking for it.`
    : `${host} did not answer within five minutes, although the app itself is installed and running.`;
  return { detail: `Last attempt on ${host}: ${lastProbe}`, message };
}

module.exports = { AppInstallJobs };
