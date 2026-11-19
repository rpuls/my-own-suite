const crypto = require('node:crypto');
const YAML = require('yaml');
const { HOMEPAGE_FILES, HomepageConfigError, homeServiceHosts, publicUrlFor, validateProxy } = require('../../../../shared/homepage-contract.cjs');
const { baseHostOf } = require('../../../../shared/suite-address.cjs');
const { Dashboard, homeServiceSubdomains, reconcileAppTiles } = require('./dashboard-model.cjs');

// Enough to step back a few changes; an owner who is happy deletes the rest.
const CHECKPOINTS_KEPT = 20;
const FILE_LABELS = { 'bookmarks.yaml': 'bookmarks', 'services.template.yaml': 'services', 'settings.yaml': 'settings', 'widgets.yaml': 'widgets' };

// The suite's recorded address in the shape the Homepage contract builds hosts
// from: the base every home-service host hangs under, and the scheme.
function domainStateFor(address) {
  return { baseDomain: baseHostOf(address), scheme: address.scheme };
}

// The agent reports content that is not YAML in its own words, so the address check skips it.
function parsedOrNothing(content) {
  try { return YAML.parse(String(content || '')) || []; } catch { return []; }
}

class HomepageService {
  // `appHosts` names the installed app on each subdomain an app is served at.
  constructor({ agent, appHosts = () => new Map(), installedAppIds = () => new Set(), now = () => new Date(), store, suiteAddress }) {
    this.agent = agent;
    this.appHosts = appHosts;
    this.installedAppIds = installedAppIds;
    this.now = now;
    this.store = store;
    this.suiteAddress = suiteAddress;
  }

  domainState() { return domainStateFor(this.suiteAddress.read()); }

  async status() {
    try {
      const status = await this.agent.status();
      return { agentAvailable: status?.capabilities?.includes('homepage.apply') === true, files: HOMEPAGE_FILES };
    } catch { return { agentAvailable: false, files: HOMEPAGE_FILES }; }
  }

  async read(body) {
    const result = await this.agent.read(body?.file);
    this.store.recordHomepageRevision({ at: this.now().toISOString(), file: result.file, revision: result.revision });
    return result;
  }

  validate(body) { return this.agent.validate(body?.file, body?.content); }

  async apply(body) {
    if (body?.file === 'services.template.yaml') {
      for (const subdomain of homeServiceHosts(parsedOrNothing(body?.content)).keys()) this.assertSubdomainFree(subdomain);
    }
    return this.runOperation('raw-save', { actor: 'You', summary: `Edited ${FILE_LABELS[body?.file] || body?.file} in Customize` }, () => this.agent.apply({
      content: body?.content,
      domainState: this.domainState(),
      expectedRevision: body?.expectedRevision,
      file: body?.file,
    }));
  }

  add(body, homeService) {
    if (homeService) this.assertSubdomainFree(body?.entry?.subdomain);
    return this.addEntry(body, { actor: 'You', homeService });
  }

  // Two sites on one address make Caddy refuse the change, with a message no owner can act on.
  assertSubdomainFree(subdomain) {
    const appName = this.appHosts().get(String(subdomain || '').trim().toLowerCase());
    if (appName) throw new HomepageConfigError('DUPLICATE_PUBLIC_HOST', `${String(subdomain).trim().toLowerCase()} is ${appName}'s address. Pick another name.`, 409);
  }

  // The Homepage links that hold an address under the suite: subdomain to link name.
  async homeServiceHosts() {
    const { content } = await this.agent.read('services.template.yaml');
    return homeServiceHosts(YAML.parse(content) || []);
  }

  // Managed app tiles link to Suite Manager's own redirect rather than to an
  // absolute app address, so the dashboard is correct through whichever door the
  // visitor arrived by. It is a separate method rather than a request field so
  // that no owner-supplied body reaching `add` can claim it.
  addManagedApp(body) { return this.addEntry(body, { actor: 'MOS', managed: true }); }

  async addEntry(body, { actor, homeService = false, managed = false } = {}) {
    const requestId = typeof body?.requestId === 'string' && body.requestId ? body.requestId : crypto.randomUUID();
    const summary = `Added ${String(body?.entry?.name || 'a tile').slice(0, 80)}`;
    const result = await this.runOperation(homeService ? 'add-home-service' : 'add-link', { actor, summary }, () => {
      const input = { domainState: this.domainState(), entry: body?.entry, expectedRevision: body?.expectedRevision, managed, requestId };
      return homeService ? this.agent.addHomeService(input) : this.agent.addLink(input);
    });
    return { ...result, requestId };
  }

  async removeLink(body) {
    return this.runOperation('remove-link', { actor: 'You', summary: 'Removed a tile' }, () => this.agent.removeLink({
      domainState: this.domainState(),
      expectedRevision: body?.expectedRevision,
      id: body?.id,
    }));
  }

  async reconcileUrls(body) {
    const current = await this.read({ file: 'services.template.yaml' });
    return this.runOperation('reconcile-urls', { actor: 'MOS', summary: 'Updated app tiles' }, () => this.agent.reconcileUrls({
      domainState: this.domainState(),
      entries: Array.isArray(body?.entries) ? body.entries : [],
      expectedRevision: current.revision,
    }));
  }

  async previewHomeService(body) {
    this.assertSubdomainFree(body?.subdomain);
    const subdomain = String(body?.subdomain || '').trim().toLowerCase();
    const linkName = (await this.homeServiceHosts()).get(subdomain);
    if (linkName) throw new HomepageConfigError('DUPLICATE_PUBLIC_HOST', `${subdomain} is already the address of ${linkName} on your Homepage. Pick another name.`, 409);
    const proxy = validateProxy({
      subdomain: body?.subdomain,
      upstream: `${body?.protocol}://${body?.host}:${body?.port}`,
    });
    return { publicUrl: publicUrlFor(proxy, this.domainState()), upstream: proxy.upstream };
  }

  async runOperation(kind, { actor, summary }, operation) {
    const id = crypto.randomUUID();
    await this.ensureBaseline();
    this.store.startHomepageOperation({ at: this.now().toISOString(), id, kind });
    let result;
    try {
      result = await operation();
    } catch (error) {
      this.store.failHomepageOperation({ at: this.now().toISOString(), errorCode: error.code || 'HOMEPAGE_APPLY_FAILED', id });
      if (error instanceof HomepageConfigError || error.statusCode) throw error;
      throw new HomepageConfigError('HOMEPAGE_APPLY_FAILED', 'Homepage could not be applied. The previous dashboard remains active.', 502);
    }
    const completedAt = this.now().toISOString();
    const revisions = Object.entries(result.revisions || (result.file ? { [result.file]: result.revision } : {}));
    this.store.completeHomepageOperation({ at: completedAt, file: revisions[0]?.[0] || null, id, revision: revisions[0]?.[1] || null });
    for (const [file, revision] of revisions.slice(1)) this.store.recordHomepageRevision({ at: completedAt, file, revision });
    if (result.changed !== false) await this.checkpoint({ actor, summary }).catch(() => {});
    return { ...result, operationId: id };
  }

  // ---- checkpoints ----

  async snapshot() {
    const files = {};
    for (const file of HOMEPAGE_FILES) files[file] = (await this.agent.read(file)).content;
    const json = JSON.stringify(files);
    return { digest: crypto.createHash('sha256').update(json).digest('hex'), files: json };
  }

  async checkpoint({ actor, summary }) {
    const { digest, files } = await this.snapshot();
    if (this.store.latestHomepageCheckpoint()?.digest === digest) return;
    this.store.addHomepageCheckpoint({
      actor: String(actor || 'MOS').slice(0, 120),
      at: this.now().toISOString(),
      digest,
      files,
      keep: CHECKPOINTS_KEPT,
      summary: String(summary || 'Changed the dashboard').slice(0, 500),
    });
  }

  // The first change ever recorded keeps how the dashboard looked before it,
  // so even that change can be stepped back from.
  async ensureBaseline() {
    if (this.store.latestHomepageCheckpoint()) return;
    await this.checkpoint({ actor: 'MOS', summary: 'How your dashboard was before' }).catch(() => {});
  }

  history() {
    const rows = this.store.homepageCheckpoints();
    return { checkpoints: rows.map((row, index) => ({ ...row, current: index === 0 })), kept: CHECKPOINTS_KEPT };
  }

  checkpointOrFail(id) {
    const row = this.store.homepageCheckpoint(Number.parseInt(id, 10));
    if (!row) throw new HomepageConfigError('HOMEPAGE_CHECKPOINT_NOT_FOUND', 'That saved version no longer exists.', 404);
    return row;
  }

  deleteCheckpoint(id) {
    const row = this.checkpointOrFail(id);
    if (this.store.latestHomepageCheckpoint()?.id === row.id) {
      throw new HomepageConfigError('HOMEPAGE_CHECKPOINT_CURRENT', 'This is how your dashboard is now, so it stays.', 409);
    }
    this.store.deleteHomepageCheckpoint(row.id);
    return this.history();
  }

  keepOnlyCurrent() {
    const latest = this.store.latestHomepageCheckpoint();
    if (latest) this.store.deleteHomepageCheckpointsBefore(latest.id);
    return this.history();
  }

  // A restore goes through the same validated apply as any change and becomes
  // a checkpoint itself, so it can be undone too. Bringing back a home service
  // would open an address again, which waits for the owner to confirm it.
  async restore(id, { actor = 'You', confirmAddresses = false } = {}) {
    const row = this.checkpointOrFail(id);
    const saved = JSON.parse(row.files);
    const current = {};
    for (const file of HOMEPAGE_FILES) current[file] = await this.agent.read(file);
    const target = { ...saved };
    if (typeof target['services.template.yaml'] === 'string') {
      target['services.template.yaml'] = reconcileAppTiles({
        current: current['services.template.yaml'].content,
        installedIds: this.installedAppIds(),
        restored: target['services.template.yaml'],
      });
      const now = homeServiceSubdomains(current['services.template.yaml'].content);
      const reopened = [...homeServiceSubdomains(target['services.template.yaml'])].filter((subdomain) => !now.has(subdomain));
      for (const subdomain of reopened) this.assertSubdomainFree(subdomain);
      if (reopened.length && !confirmAddresses) {
        throw new HomepageConfigError(
          'HOMEPAGE_RESTORE_OPENS_ADDRESSES',
          `Restoring this version brings back ${reopened.length === 1 ? 'an address' : 'addresses'} on your suite: ${reopened.join(', ')}. Confirm to restore it.`,
          409,
          reopened,
        );
      }
    }
    const files = HOMEPAGE_FILES
      .filter((file) => typeof target[file] === 'string' && target[file] !== current[file].content)
      .map((file) => ({ content: target[file], expectedRevision: current[file].revision, file }));
    if (!files.length) return { changed: false, history: this.history() };
    const result = await this.runOperation('restore', { actor, summary: 'Went back to an earlier version' }, () => this.agent.applyFiles({ domainState: this.domainState(), files }));
    return { ...result, history: this.history() };
  }

  // ---- the dashboard as a model ----

  async dashboardFiles() {
    return { services: await this.agent.read('services.template.yaml'), settings: await this.agent.read('settings.yaml') };
  }

  async dashboard() {
    const { services, settings } = await this.dashboardFiles();
    return new Dashboard({ services: services.content, settings: settings.content }).model();
  }

  async changeDashboard({ actor, operations, preview = false }) {
    const { services, settings } = await this.dashboardFiles();
    const next = new Dashboard({ services: services.content, settings: settings.content }).apply(operations);
    const files = [
      { content: next.services, expectedRevision: services.revision, file: 'services.template.yaml', unchanged: next.services === services.content },
      { content: next.settings, expectedRevision: settings.revision, file: 'settings.yaml', unchanged: next.settings === settings.content },
    ].filter((item) => !item.unchanged).map(({ unchanged: _unchanged, ...item }) => item);
    if (preview || !files.length) {
      for (const item of files) await this.agent.validate(item.file, item.content);
      return { applied: false, summary: next.summary };
    }
    await this.runOperation('dashboard-change', { actor, summary: next.summary.join('; ') }, () => this.agent.applyFiles({ domainState: this.domainState(), files }));
    return { applied: true, summary: next.summary };
  }
}

module.exports = { HomepageService, domainStateFor };
