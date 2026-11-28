'use strict';

const fs = require('node:fs');

const { TOOL_KINDS } = require('../apps/ai-tools-file.cjs');
const { digestFor, loopbackPortFor, readSecretValue, secretFilePath } = require('../apps/app-package-internals.cjs');
const { listAllTools } = require('./mcp-upstream.cjs');

const MCP_EXPORT_TYPE = 'mcp-server';
const OFFERABLE_KINDS = new Set(['read', 'add', 'change']);
const APP_TOKEN_KEY = 'ai-token';
const CATALOG_TTL_MS = 60_000;
const LISTED_STATUSES = new Set(['installed', 'disabled']);
const BUILTIN_SOURCE_ID = 'mos';

// A manifest tool entry is its kind, or { kind, title, note, fixed }.
function toolSpecOf(entry) {
  const spec = typeof entry === 'string' ? { kind: entry } : entry && typeof entry === 'object' ? entry : {};
  if (!TOOL_KINDS.has(spec.kind)) return null;
  return {
    fixed: spec.fixed && typeof spec.fixed === 'object' && !Array.isArray(spec.fixed) ? spec.fixed : {},
    kind: spec.kind,
    note: typeof spec.note === 'string' ? spec.note : null,
    title: typeof spec.title === 'string' ? spec.title : null,
  };
}

// The one `exports` entry of type mcp-server with the tools its ai-tools.json
// lists, or null. Validation has already refused malformed ones; this only
// guards against reading a snapshot it never saw.
function mcpExportOf(manifest, aiTools) {
  const exports = manifest?.exports && typeof manifest.exports === 'object' ? manifest.exports : {};
  const found = Object.values(exports).find((entry) => entry?.type === MCP_EXPORT_TYPE);
  if (!found || typeof found.service !== 'string' || typeof found.path !== 'string' || !found.path.startsWith('/')) return null;
  const listed = aiTools?.tools;
  const tools = Object.entries(listed && typeof listed === 'object' ? listed : {})
    .map(([name, entry]) => [name, toolSpecOf(entry)])
    .filter(([, spec]) => spec);
  const packageSecret = found.auth?.kind === 'package-secret' && typeof found.auth.secret === 'string' ? found.auth.secret : null;
  return {
    hint: typeof found.auth?.hint === 'string' ? found.auth.hint : null,
    packageSecret,
    path: found.path,
    service: found.service,
    signIn: packageSecret && typeof found.auth.signIn === 'string' ? found.auth.signIn : null,
    tokenPage: typeof found.auth?.tokenPage === 'string' ? found.auth.tokenPage : null,
    tools: new Map(tools),
    verifyTool: typeof found.auth?.verifyTool === 'string' ? found.auth.verifyTool : null,
  };
}

function readTrimmed(secretDir, secretPath) {
  try {
    return readSecretValue(secretDir, secretPath).trim() || null;
  } catch {
    return null;
  }
}

function toolPrefixOf(packageId) {
  return `${String(packageId).replace(/[^A-Za-z0-9]/gu, '_')}_`;
}

// The description is pinned too: rewriting it after approval is how a tool
// would smuggle new instructions past an owner who already said yes.
function toolHash(tool) {
  return digestFor([tool.name, tool.description ?? null, tool.inputSchema ?? null, tool.annotations ?? null]);
}

class AiToolCatalog {
  constructor({ appPackages, builtin = null, fetchImpl = fetch, now = () => new Date(), secretDir, store }) {
    this.appPackages = appPackages;
    this.builtin = builtin;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.secretDir = secretDir;
    this.store = store;
    this.cache = new Map();
  }

  sources() {
    const sources = this.builtin ? [{ ...this.builtin, id: BUILTIN_SOURCE_ID, prefix: toolPrefixOf(BUILTIN_SOURCE_ID), running: true }] : [];
    for (const instance of this.store.getAppInstances()) {
      if (!LISTED_STATUSES.has(instance.status) || instance.packageId === BUILTIN_SOURCE_ID) continue;
      let appPackage;
      try { appPackage = this.appPackages.installedPackageFor(instance); } catch { continue; }
      const { manifest } = appPackage;
      const mcp = mcpExportOf(manifest, appPackage.aiTools);
      if (!mcp) continue;
      sources.push({
        id: instance.packageId,
        instance,
        mcp,
        name: instance.displayNameSnapshot || manifest.name || instance.packageId,
        prefix: toolPrefixOf(instance.packageId),
        running: instance.status === 'installed' && instance.enabled === true,
        url: `http://127.0.0.1:${loopbackPortFor(instance.packageId, mcp.service)}${mcp.path}`,
      });
    }
    return sources;
  }

  // Every app MOS still has, stopped or mid-update too: only an uninstalled app's AI settings may be forgotten.
  keptSources() {
    const ids = [...(this.builtin ? [BUILTIN_SOURCE_ID] : []), ...this.store.getAppInstances().map((instance) => instance.packageId)];
    return ids.map((id) => ({ id, prefix: toolPrefixOf(id) }));
  }

  source(id) {
    return this.sources().find((candidate) => candidate.id === id) || null;
  }

  // An app with a package secret is reached with the key MOS generated at install;
  // only an app with its own sign-in needs a token from the owner.
  tokenPath(source) {
    if (!source.instance) return null;
    return secretFilePath(this.secretDir, source.instance.id, source.mcp.packageSecret || APP_TOKEN_KEY);
  }

  tokenOf(source) {
    return source.instance ? readTrimmed(this.secretDir, this.tokenPath(source)) : null;
  }

  // The token the app itself gave MOS for the owner, pasted or got by signing in once.
  // Null path for an app MOS reaches with its own key alone.
  ownerTokenPath(source) {
    if (!source.instance || (source.mcp.packageSecret && !source.mcp.signIn)) return null;
    return secretFilePath(this.secretDir, source.instance.id, APP_TOKEN_KEY);
  }

  ownerTokenOf(source) {
    const tokenPath = this.ownerTokenPath(source);
    return tokenPath ? readTrimmed(this.secretDir, tokenPath) : null;
  }

  tokenConfiguredAt(source) {
    try { return fs.statSync(this.ownerTokenPath(source)).mtime.toISOString(); } catch { return null; }
  }

  forget(sourceId = null) {
    if (sourceId) this.cache.delete(sourceId);
    else this.cache.clear();
  }

  entryFor(source, tool, spec) {
    return {
      annotations: tool.annotations,
      description: typeof tool.description === 'string' ? tool.description : '',
      fixed: spec.fixed,
      hash: toolHash(tool),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' },
      kind: spec.kind,
      name: `${source.prefix}${tool.name}`,
      note: spec.note,
      title: spec.title || tool.title || tool.annotations?.title || tool.name,
      upstreamName: tool.name,
    };
  }

  // The source's declared tools, as its server currently describes them. A tool
  // the manifest does not list is never returned, whatever the server advertises.
  async toolsOf(source) {
    if (source.id === BUILTIN_SOURCE_ID) {
      return { error: null, tools: source.tools.map((tool) => this.entryFor(source, tool, tool)) };
    }
    const cached = this.cache.get(source.id);
    if (cached && this.now().getTime() - cached.at < CATALOG_TTL_MS) return cached.value;
    let value;
    if (!source.running) {
      value = { error: `${source.name} is not running right now.`, tools: [] };
    } else {
      try {
        const advertised = await listAllTools({ fetchImpl: this.fetchImpl, timeoutMs: 10_000, token: this.tokenOf(source), url: source.url });
        const tools = advertised
          .filter((tool) => typeof tool?.name === 'string' && source.mcp.tools.has(tool.name))
          .map((tool) => this.entryFor(source, tool, source.mcp.tools.get(tool.name)));
        value = { error: null, tools };
      } catch (error) {
        value = { error: `MOS could not read the tools ${source.name} offers: ${error.message}`, tools: [] };
      }
    }
    this.cache.set(source.id, { at: this.now().getTime(), value });
    return value;
  }

  async allTools() {
    const entries = [];
    for (const source of this.sources()) {
      const { tools } = await this.toolsOf(source);
      for (const tool of tools) entries.push({ source, tool });
    }
    return entries;
  }

  async find(toolName) {
    const source = this.sources()
      .filter((candidate) => toolName.startsWith(candidate.prefix))
      .sort((left, right) => right.prefix.length - left.prefix.length)[0];
    if (!source) return null;
    const { error, tools } = await this.toolsOf(source);
    const tool = tools.find((candidate) => candidate.name === toolName);
    return { error, source, tool: tool || null };
  }
}

module.exports = {
  APP_TOKEN_KEY,
  AiToolCatalog,
  BUILTIN_SOURCE_ID,
  MCP_EXPORT_TYPE,
  OFFERABLE_KINDS,
  TOOL_KINDS,
  mcpExportOf,
  toolHash,
  toolPrefixOf,
  toolSpecOf,
};
