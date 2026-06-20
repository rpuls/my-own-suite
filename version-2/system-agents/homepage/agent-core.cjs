const {
  HOMEPAGE_FILES,
  HomepageConfigError,
  addEntry,
  assertAllowedFile,
  projectServices,
  renderCaddyRoutes,
  revisionFor,
  validateYaml,
} = require('../../shared/homepage-contract.cjs');

function exactKeys(value, expected) {
  const keys = Object.keys(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).sort();
  return keys.join(',') === [...expected].sort().join(',');
}

class HomepageAgentCore {
  constructor(adapter) { this.adapter = adapter; }

  async status() {
    return {
      capabilities: ['homepage.read', 'homepage.apply', 'homepage.add-link', 'homepage.add-home-service'],
      files: HOMEPAGE_FILES,
      service: 'mos-v2-homepage-agent',
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

  async add(input, homeService) {
    if (!exactKeys(input, ['domainState', 'entry', 'expectedRevision', 'requestId'])) {
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
    const mutation = addEntry(current, input.entry, { homeService, id: input.requestId });
    if (!mutation.changed) return { changed: false, file, id: mutation.id, revision: revisionFor(current) };
    const result = await this.applyFile(file, mutation.content, input.expectedRevision, input.domainState);
    return { ...result, id: mutation.id };
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
