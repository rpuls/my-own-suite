const { HOMEPAGE_FILES, HomepageConfigError } = require('../../shared/homepage-contract.cjs');
const {
  addEntry,
  assertAllowedFile,
  projectServices,
  reconcileManagedUrls,
  removeEntryById,
  renderCaddyRoutes,
  revisionFor,
  validateYaml,
} = require('./document.cjs');

function exactKeys(value, expected) {
  const keys = Object.keys(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).sort();
  return keys.join(',') === [...expected].sort().join(',');
}

class HomepageAgentCore {
  constructor(adapter) { this.adapter = adapter; }

  async status() {
    return {
      capabilities: ['homepage.read', 'homepage.apply', 'homepage.apply-files', 'homepage.add-link', 'homepage.add-managed-app', 'homepage.add-home-service', 'homepage.remove-link', 'homepage.reconcile-urls'],
      files: HOMEPAGE_FILES,
      service: 'mos-homepage-agent',
    };
  }

  async read(input) {
    if (!exactKeys(input, ['file'])) throw new HomepageConfigError('INVALID_REQUEST_SHAPE', 'Only a Homepage file name is accepted.');
    const file = assertAllowedFile(input.file);
    const content = await this.adapter.readHomepageFile(file);
    return { content, file, revision: revisionFor(content) };
  }

  async validate(input) {
    if (!exactKeys(input, ['content', 'file'])) throw new HomepageConfigError('INVALID_REQUEST_SHAPE', 'Only file and content are accepted.');
    validateYaml(input.content, assertAllowedFile(input.file));
    return { valid: true };
  }

  async apply(input) {
    if (!exactKeys(input, ['content', 'domainState', 'expectedRevision', 'file'])) {
      throw new HomepageConfigError('INVALID_REQUEST_SHAPE', 'Only the documented Homepage apply fields are accepted.');
    }
    return this.applyFile(assertAllowedFile(input.file), input.content, input.expectedRevision, input.domainState);
  }

  // Several files in one transaction, so a change that spans the services and
  // the settings lands whole or not at all. Every file is checked against the
  // revision the caller read before anything is written.
  async applyFiles(input) {
    if (!exactKeys(input, ['domainState', 'files']) || !Array.isArray(input.files) || !input.files.length) {
      throw new HomepageConfigError('INVALID_REQUEST_SHAPE', 'Only the documented Homepage apply fields are accepted.');
    }
    const files = {};
    for (const item of input.files) {
      if (!exactKeys(item, ['content', 'expectedRevision', 'file'])) {
        throw new HomepageConfigError('INVALID_REQUEST_SHAPE', 'Each file needs its name, content and the revision it was read at.');
      }
      const file = assertAllowedFile(item.file);
      if (Object.hasOwn(files, file)) throw new HomepageConfigError('INVALID_REQUEST_SHAPE', 'Each file can be applied once per change.');
      validateYaml(item.content, file);
      const current = await this.adapter.readHomepageFile(file);
      if (revisionFor(current) !== item.expectedRevision) {
        throw new HomepageConfigError('HOMEPAGE_REVISION_CONFLICT', 'Homepage configuration changed. Reload it before saving.', 409);
      }
      if (current !== item.content) files[file] = item.content;
    }
    const revisions = Object.fromEntries(input.files.map((item) => [item.file, revisionFor(item.content)]));
    if (!Object.keys(files).length) return { changed: false, revisions, steps: ['validated'] };
    let caddyRoutes = null;
    if (Object.hasOwn(files, 'services.template.yaml')) {
      files['services.yaml'] = projectServices(files['services.template.yaml'], input.domainState);
      caddyRoutes = renderCaddyRoutes(files['services.template.yaml'], input.domainState);
    }
    const result = await this.adapter.applyTransaction({ caddyRoutes, files, restartHomepage: true });
    return { changed: true, revisions, steps: result.steps };
  }

  async add(input, homeService) {
    if (!exactKeys(input, ['domainState', 'entry', 'expectedRevision', 'managed', 'requestId'])) {
      throw new HomepageConfigError('INVALID_REQUEST_SHAPE', 'Only the documented guided-entry fields are accepted.');
    }
    if (!/^[0-9a-f-]{36}$/u.test(String(input.requestId || ''))) {
      throw new HomepageConfigError('INVALID_REQUEST_ID', 'A stable request ID is required.');
    }
    const file = 'services.template.yaml';
    const current = await this.adapter.readHomepageFile(file);
    if (revisionFor(current) !== input.expectedRevision) {
      throw new HomepageConfigError('HOMEPAGE_REVISION_CONFLICT', 'Homepage configuration changed. Reload it before saving.', 409);
    }
    const mutation = addEntry(current, input.entry, { homeService, id: input.requestId, managed: input.managed === true });
    if (!mutation.changed) return { changed: false, file, id: mutation.id, revision: revisionFor(current) };
    const result = await this.applyFile(file, mutation.content, input.expectedRevision, input.domainState);
    return { ...result, id: mutation.id };
  }

  async removeLink(input) {
    if (!exactKeys(input, ['domainState', 'expectedRevision', 'id'])) {
      throw new HomepageConfigError('INVALID_REQUEST_SHAPE', 'Only the documented guided-removal fields are accepted.');
    }
    const file = 'services.template.yaml';
    const current = await this.adapter.readHomepageFile(file);
    if (revisionFor(current) !== input.expectedRevision) {
      throw new HomepageConfigError('HOMEPAGE_REVISION_CONFLICT', 'Homepage configuration changed. Reload it before saving.', 409);
    }
    const mutation = removeEntryById(current, input.id);
    if (!mutation.changed) return { changed: false, file, id: mutation.id, revision: revisionFor(current) };
    const result = await this.applyFile(file, mutation.content, input.expectedRevision, input.domainState);
    return { ...result, id: mutation.id };
  }

  async reconcileUrls(input) {
    if (!exactKeys(input, ['domainState', 'entries', 'expectedRevision'])) {
      throw new HomepageConfigError('INVALID_REQUEST_SHAPE', 'Only the documented URL reconciliation fields are accepted.');
    }
    const file = 'services.template.yaml';
    const current = await this.adapter.readHomepageFile(file);
    if (revisionFor(current) !== input.expectedRevision) {
      throw new HomepageConfigError('HOMEPAGE_REVISION_CONFLICT', 'Homepage configuration changed. Reload it before saving.', 409);
    }
    const mutation = reconcileManagedUrls(current, input.entries);
    const content = mutation.content;
    const files = {
      [file]: content,
      'services.yaml': projectServices(content, input.domainState),
    };
    const result = await this.adapter.applyTransaction({
      caddyRoutes: renderCaddyRoutes(content, input.domainState),
      files,
      restartHomepage: true,
    });
    return {
      changed: mutation.changed || result.steps.includes('homepage-restarted') || result.steps.includes('caddy-reloaded'),
      file,
      revision: revisionFor(content),
      steps: result.steps,
    };
  }

  async applyFile(file, content, expectedRevision, domainState) {
    validateYaml(content, file);
    const current = await this.adapter.readHomepageFile(file);
    if (revisionFor(current) !== expectedRevision) {
      throw new HomepageConfigError('HOMEPAGE_REVISION_CONFLICT', 'Homepage configuration changed. Reload it before saving.', 409);
    }
    if (current === content) return { changed: false, file, revision: expectedRevision, steps: ['validated'] };

    const files = { [file]: content };
    let caddyRoutes = null;
    if (file === 'services.template.yaml') {
      files['services.yaml'] = projectServices(content, domainState);
      caddyRoutes = renderCaddyRoutes(content, domainState);
    }
    const result = await this.adapter.applyTransaction({ caddyRoutes, files, restartHomepage: true });
    return {
      changed: true,
      file,
      revision: revisionFor(content),
      steps: result.steps,
    };
  }
}

module.exports = { HomepageAgentCore, exactKeys };
