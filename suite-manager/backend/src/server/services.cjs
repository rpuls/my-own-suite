const fs = require('node:fs');
const path = require('node:path');

const { PUBLIC_CLOUD_FRONT_DOORS } = require('../../../../infrastructure/control-plane-runtime.cjs');
const { SuiteAddressFile, suiteAddressDir } = require('../../../../shared/suite-address.cjs');
const { createAppPublicUrls } = require('../address/app-public-urls.cjs');
const { SuiteAddressService } = require('../address/suite-address-service.cjs');
const { AppAgentClient } = require('../apps/app-agent-client.cjs');
const { AppInstallJobs } = require('../apps/app-install-jobs.cjs');
const { AppOperationLimiter } = require('../apps/app-operation-limits.cjs');
const { AppPackageService } = require('../apps/app-package-service.cjs');
const { AppUpdateJobs } = require('../apps/app-update-jobs.cjs');
const { sweepCandidateRoot } = require('../apps/candidate-storage.cjs');
const { ExternalSourceClient } = require('../apps/external-source-client.cjs');
const { ExternalSourceService } = require('../apps/external-source-service.cjs');
const { OfficialCatalogService } = require('../apps/official-catalog-service.cjs');
const { inspectAppPackages } = require('../apps/package-manifest.cjs');
const { LoginThrottle, loadThrottleKey } = require('../auth/login-throttle.cjs');
const { SignInAlerts } = require('../auth/sign-in-alerts.cjs');
const { SignInService } = require('../auth/sign-in-service.cjs');
const { BackupAgentClient } = require('../backups/backup-agent-client.cjs');
const { BackupInventoryService } = require('../backups/backup-inventory-service.cjs');
const { DiagnosticsAgentClient } = require('../diagnostics/diagnostics-agent-client.cjs');
const { HomepageAgentClient } = require('../homepage/homepage-agent-client.cjs');
const { HomepageService } = require('../homepage/homepage-service.cjs');
const { LabResetAgentClient } = require('../lab/lab-reset-agent-client.cjs');
const { ConsoleLoginService } = require('../settings/console-login-service.cjs');
const { HttpsAgentClient } = require('../settings/https-agent-client.cjs');
const { SmtpSettingsService } = require('../settings/smtp-settings-service.cjs');
const { VaultAgentClient } = require('../settings/vault-agent-client.cjs');
const { VaultService } = require('../settings/vault-service.cjs');
const { HandoverService } = require('../setup/handover-service.cjs');
const { SetupService } = require('../setup/setup-service.cjs');
const { UpdateAgentClient } = require('../updates/update-agent-client.cjs');
const { UpdateService } = require('../updates/update-service.cjs');
const { createHomepageProxy } = require('./homepage-proxy.cjs');
const { createLogger } = require('./logger.cjs');

const DEFAULT_FRONTEND_DIST_DIR = path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist');
const DEFAULT_APPS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'apps');

// Suite Manager's state is one directory inside the machine's state root.
function stateRootOf(stateDir) {
  if (process.env.MOS_STATE_ROOT) return process.env.MOS_STATE_ROOT;
  return path.dirname(path.resolve(stateDir));
}

function createOfficialCatalog({ limiter, logger, recordSecurityEvent, stateDir, updateAgent }) {
  // Per process, so a fresh start pushes the host holds once even when the feed has not moved.
  let pushedAdvisoryRevision = null;
  const catalogService = new OfficialCatalogService({
    limiter,
    logger,
    // Suite Manager only carries the signed advisories; the update agent verifies them before it writes.
    onRefreshed: async ({ advisoriesRevision }) => {
      if (advisoriesRevision === pushedAdvisoryRevision) return;
      const signed = catalogService.signedAdvisories();
      if (!signed) return;
      try {
        await updateAgent.applyHostHolds({ advisoriesSignature: signed.signature, advisoriesText: signed.text });
        pushedAdvisoryRevision = advisoriesRevision;
      } catch (error) {
        logger?.warn('host-package-holds-push-failed', { reason: error instanceof Error ? error.message : 'unknown' });
      }
    },
    recordSecurityEvent,
    repository: process.env.MOS_APP_CATALOG_REPOSITORY || 'https://github.com/rpuls/my-own-suite',
    // A branch track reads its own branch's catalog; a release reads `main`.
    resolveCatalogRef: async () => {
      if (process.env.MOS_APP_CATALOG_BRANCH) return process.env.MOS_APP_CATALOG_BRANCH;
      const { track } = await updateAgent.summary();
      if (track?.type === 'branch') return track.ref || null;
      return track?.type === 'stable' ? 'main' : null;
    },
    // From the installed release, never from whoever served the catalog.
    signingPublicKey: fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'trust', 'official-catalog.pub'), 'utf8'),
    stateDir,
    platformVersion: fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'VERSION'), 'utf8').trim(),
  });
  return catalogService;
}

// Installs and updates that build for minutes run as jobs the page reads back.
function createAppJobs({ appAgent, appPackages, appUrls, homepageConfig, logger }) {
  const installJobs = new AppInstallJobs({
    addToHomepage: (packageId) => appPackages.addPackageToHomepage(packageId, homepageConfig, appUrls.publicUrlOf(packageId)),
    logger,
    prepare: (packageId, config) => appPackages.installPackage(packageId, { config }),
    progressOf: (packageId) => appPackages.installProgressOf(packageId),
    start: (packageId) => appPackages.startPackageRuntime(packageId, { ...appUrls.publicUrlOf(packageId), publicUrlFor: appUrls.publicUrls() }),
    waitForAddress: (packageId) => appAgent.waitForAddress({ publicUrl: appUrls.publicUrlOf(packageId).publicUrl }),
  });
  const updateJobs = new AppUpdateJobs({
    logger,
    stage: (packageId, input, onStage) => appPackages.stagePackageUpdate(packageId, input, {
      ...appUrls.publicUrlOf(packageId),
      homepageService: homepageConfig,
      publicUrlFor: appUrls.publicUrls(),
    }, onStage),
  });
  return { installJobs, updateJobs };
}

function createServices({
  appAgent = new AppAgentClient(),
  backupAgent = new BackupAgentClient(),
  diagnosticsAgent = new DiagnosticsAgentClient(),
  appsDir = DEFAULT_APPS_DIR,
  homepageAgent = new HomepageAgentClient(),
  httpsAgent = new HttpsAgentClient(),
  labResetAgent = new LabResetAgentClient(),
  updateAgent = new UpdateAgentClient(),
  vaultAgent = new VaultAgentClient(),
  frontendDistDir = DEFAULT_FRONTEND_DIST_DIR,
  frontDoor = process.env.MOS_FRONT_DOOR || 'ssh-bootstrap',
  homeHost = process.env.MOS_HOME_HOST || 'home.localhost',
  homepageUpstream = process.env.MOS_HOMEPAGE_UPSTREAM || 'http://127.0.0.1:3200',
  disposableLab = process.env.MOS_DISPOSABLE_LAB === '1',
  loginThrottle = null,
  signInAlerts = null,
  logger = createLogger(),
  securityLogger = (event) => logger.warn('security-event', event),
  securityEventRecorder = null,
  ownerClaimToken = process.env.MOS_OWNER_CLAIM_TOKEN || '',
  stateDir = path.join(process.cwd(), '.state'),
  suiteAddress = new SuiteAddressFile({ dir: suiteAddressDir(stateRootOf(stateDir)) }),
  detectAddress = undefined,
  probeEasyDoorCertificate = undefined,
  officialCatalog = null,
  externalSources = null,
} = {}) {
  const setup = new SetupService({ stateDir });
  // Not a parameter default: the durable backoff needs the store setup creates.
  const throttle = loginThrottle || new LoginThrottle({ key: loadThrottleKey(stateDir), store: setup.store });
  const recordSecurityEvent = securityEventRecorder || ((event) => setup.store.recordSecurityEvent(event));
  const consoleLogin = new ConsoleLoginService({ stateDir });
  const handover = new HandoverService({ consoleLogin, logger, vaultAgent });
  const vault = new VaultService({ agent: vaultAgent, logger, verifyOwnerPassword: (password) => setup.verifyOwnerPassword(password) });

  const homepage = createHomepageProxy({ upstream: homepageUpstream, upstreamHost: homeHost });
  const homepageConfig = new HomepageService({
    agent: homepageAgent,
    store: setup.store,
    suiteAddress,
  });
  // One limiter for the host: the bounds only mean something when shared.
  const appOperationLimiter = new AppOperationLimiter();
  const catalogService = officialCatalog || createOfficialCatalog({ limiter: appOperationLimiter, logger, recordSecurityEvent, stateDir, updateAgent });
  const officialPackageIds = inspectAppPackages(appsDir).map((pkg) => pkg.id);
  const externalSourceClient = new ExternalSourceClient({
    limiter: appOperationLimiter,
    officialPackageIds,
    platformVersion: catalogService.platformVersion,
    recordSecurityEvent,
    stateDir: setup.store.stateDir,
  });
  // The package and source services need each other, so this one is assigned after.
  let externalSourceService = null;
  const appPackages = new AppPackageService({
    agent: appAgent,
    appsDir,
    catalogService,
    externalCatalog: () => externalSourceService?.catalogPackages() || [],
    externalClient: externalSourceClient,
    limiter: appOperationLimiter,
    store: setup.store,
    suiteAddress,
  });
  // The same secret directory app runtimes read ${smtp.*} from.
  const smtpSettings = new SmtpSettingsService({
    secretDir: appPackages.secretDir,
    store: setup.store,
  });
  const alerts = signInAlerts || new SignInAlerts({ homeHost, logger, smtpSettings, store: setup.store });
  const signIn = new SignInService({ alerts, recordSecurityEvent, securityLogger, setup, throttle, vault });
  const appUrls = createAppPublicUrls({ appPackages, homepageConfig, suiteAddress });
  // Built after the app and Homepage services because moving the address re-bakes both.
  const addressService = new SuiteAddressService({
    agent: httpsAgent,
    bootstrapHost: homeHost,
    bootstrapScheme: PUBLIC_CLOUD_FRONT_DOORS.includes(frontDoor) ? 'https' : 'http',
    detectAddress,
    frontDoor,
    installedApps: () => setup.store.getAppInstances().filter((instance) => instance.status === 'installed').map((instance) => instance.displayNameSnapshot || instance.packageId),
    probeCertificate: probeEasyDoorCertificate,
    logger,
    rebake: appUrls.rebake,
    store: setup.store,
    suiteAddress,
  });
  addressService.start();
  const { installJobs, updateJobs } = createAppJobs({ appAgent, appPackages, appUrls, homepageConfig, logger });
  externalSourceService = externalSources || new ExternalSourceService({
    allowLocalSources: process.env.MOS_ALLOW_LOCAL_APP_SOURCES === '1',
    appPackages,
    client: externalSourceClient,
    officialPackageIds,
    platformVersion: catalogService.platformVersion,
    store: setup.store,
  });
  const backupInventory = new BackupInventoryService({
    appsDir,
    stateDir,
    store: setup.store,
  });
  const updates = new UpdateService({ agent: updateAgent, backupAgent, diagnosticsAgent });

  const services = {
    addressService,
    appAgent,
    appPackages,
    appUrls,
    backupAgent,
    backupInventory,
    catalogService,
    consoleLogin,
    diagnosticsAgent,
    disposableLab,
    externalSourceService,
    frontDoor,
    frontendDistDir,
    handover,
    homeHost,
    homepage,
    homepageConfig,
    installJobs,
    labResetAgent,
    logger,
    ownerClaimToken,
    setup,
    signIn,
    smtpSettings,
    suiteAddress,
    updateJobs,
    updates,
    vault,
    vaultAgent,
  };
  return { ...services, start: () => startServices(services), stop: () => stopServices(services) };
}

async function startCatalogRefresh(catalogService) {
  try { await catalogService.refresh(); } catch {}
  catalogService.schedule();
}

// Candidates left by a Suite Manager killed mid-download belong to nobody once it restarts.
async function startServices({ addressService, appPackages, appUrls, catalogService, setup }) {
  const recoveries = await appPackages.recoverInterruptedUpdates({ publicUrlFor: appUrls.publicUrls() });
  const sweptCandidates = sweepCandidateRoot(setup.store.stateDir);
  void startCatalogRefresh(catalogService);
  addressService.watchEasyDoor();
  return { recoveries, sweptCandidates };
}

function stopServices({ addressService, catalogService, setup }) {
  catalogService.stop();
  addressService.stopWatchingEasyDoor();
  setup.close();
}

module.exports = { createServices };
