import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { isMap, isSeq, parseDocument, type Document, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';

import type { SuiteManagerConfig } from '../../config.ts';
import {
  createCaddyProxyPreviewFromServicesTemplate,
  type CaddyProxyPreview,
  type CaddyProxyPreviewError,
} from './caddy-preview.ts';

export type HomepageConfigFile = {
  description: string;
  generated: boolean;
  language: 'css' | 'javascript' | 'yaml';
  name: string;
};

export type HomepageConfigExportFile = HomepageConfigFile & {
  content: string;
};

export type HomepageConfigValidation = {
  caddyPreview: CaddyProxyPreview | null;
  errors: CaddyProxyPreviewError[];
  valid: boolean;
};

export type HomepageExternalService = {
  description: string;
  group: string;
  href: string;
  icon: string;
  id: string;
  proxyEnabled: boolean;
  title: string;
  upstream: string;
  upstreamTlsInsecureSkipVerify: boolean;
};

export type HomepageExternalServiceInput = {
  description?: unknown;
  group?: unknown;
  href?: unknown;
  icon?: unknown;
  proxyEnabled?: unknown;
  title?: unknown;
  upstream?: unknown;
  upstreamTlsInsecureSkipVerify?: unknown;
};

export type HomepageExternalServicesResult = {
  defaultDomain: string;
  defaultUrlScheme: string;
  groups: string[];
  services: HomepageExternalService[];
};

const EDITABLE_FILES: HomepageConfigFile[] = [
  {
    description: 'Service groups and tiles. Homepage regenerates services.yaml from this file at startup.',
    generated: false,
    language: 'yaml',
    name: 'services.template.yaml',
  },
  { description: 'Bookmarks shown by Homepage.', generated: false, language: 'yaml', name: 'bookmarks.yaml' },
  { description: 'Homepage widgets.', generated: false, language: 'yaml', name: 'widgets.yaml' },
  { description: 'Homepage settings.', generated: false, language: 'yaml', name: 'settings.yaml' },
  { description: 'Local visual overrides.', generated: false, language: 'css', name: 'custom.css' },
  { description: 'Local browser-side customization.', generated: false, language: 'javascript', name: 'custom.js' },
  { description: 'Homepage Docker integration settings.', generated: false, language: 'yaml', name: 'docker.yaml' },
  { description: 'Homepage Kubernetes integration settings.', generated: false, language: 'yaml', name: 'kubernetes.yaml' },
];

function getFile(name: string): HomepageConfigFile {
  const file = EDITABLE_FILES.find((candidate) => candidate.name === name);
  if (!file) {
    throw new Error('Unknown Homepage config file.');
  }
  return file;
}

function resolveWithin(baseDir: string, name: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, name);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error('Invalid Homepage config path.');
  }
  return resolvedPath;
}

function collectConfigValidationErrors(file: HomepageConfigFile, content: string): CaddyProxyPreviewError[] {
  if (file.language !== 'yaml') {
    return [];
  }

  const document = parseDocument(content, { prettyErrors: true });
  const firstError = document.errors[0];
  if (firstError) {
    return [{ message: `Invalid YAML: ${firstError.message}`, path: file.name }];
  }

  return [];
}

function validateConfigContent(file: HomepageConfigFile, content: string): void {
  const errors = collectConfigValidationErrors(file, content);
  const firstError = errors[0];
  if (firstError) {
    throw new Error(`${firstError.path}: ${firstError.message}`);
  }
}

function stringifyKey(key: unknown): string {
  if (key && typeof key === 'object' && 'value' in key) {
    const value = (key as { value: unknown }).value;
    return typeof value === 'string' ? value : String(value);
  }

  return typeof key === 'string' ? key : String(key);
}

function getMapValue(map: YAMLMap, key: string): unknown {
  return map.get(key);
}

function getMapString(map: YAMLMap, key: string): string {
  const value = getMapValue(map, key);
  return typeof value === 'string' ? value : '';
}

function getMapBoolean(map: YAMLMap, key: string): boolean {
  return getMapValue(map, key) === true;
}

function getSinglePair(map: YAMLMap): Pair | null {
  return map.items.length === 1 ? map.items[0] || null : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function normalizeInputString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeExternalServiceInput(input: HomepageExternalServiceInput): Omit<HomepageExternalService, 'id'> {
  const title = normalizeInputString(input.title);
  const href = normalizeInputString(input.href);
  const upstream = normalizeInputString(input.upstream);
  const proxyEnabled = input.proxyEnabled === true;

  if (!title) {
    throw new Error('Name is required.');
  }

  if (!href || !isHttpUrl(href)) {
    throw new Error('Link must be a full http or https URL.');
  }

  if (proxyEnabled && (!upstream || !isHttpUrl(upstream))) {
    throw new Error('Address must be a full http or https URL when external service links are enabled.');
  }

  return {
    description: normalizeInputString(input.description),
    group: normalizeInputString(input.group) || 'My External Services',
    href,
    icon: normalizeInputString(input.icon),
    proxyEnabled,
    title,
    upstream: proxyEnabled ? upstream : '',
    upstreamTlsInsecureSkipVerify: input.upstreamTlsInsecureSkipVerify === true,
  };
}

function collectGroupNames(root: YAMLSeq): string[] {
  return Array.from(new Set(collectLeafGroups(root).map((group) => group.name))).sort((left, right) =>
    left.localeCompare(right),
  );
}

type ServiceTileLocation = {
  group: string;
  parentSeq: YAMLSeq;
  pair: Pair;
  tile: YAMLMap;
  tileNode: YAMLMap;
};

function collectServiceTileLocations(node: unknown, group = '', parentSeq: YAMLSeq | null = null): ServiceTileLocation[] {
  if (isSeq(node)) {
    return node.items.flatMap((child) => collectServiceTileLocations(child, group, node));
  }

  if (!isMap(node)) {
    return [];
  }

  const pair = getSinglePair(node);
  if (!pair) {
    return [];
  }

  const title = stringifyKey(pair.key);
  if (isSeq(pair.value)) {
    return collectServiceTileLocations(pair.value, title, null);
  }

  if (isMap(pair.value) && parentSeq) {
    return [{ group, parentSeq, pair, tile: pair.value, tileNode: node }];
  }

  return [];
}

function collectLeafGroups(node: unknown): Array<{ name: string; seq: YAMLSeq }> {
  if (isSeq(node)) {
    return node.items.flatMap((child) => collectLeafGroups(child));
  }

  if (!isMap(node)) {
    return [];
  }

  const pair = getSinglePair(node);
  if (!pair || !isSeq(pair.value)) {
    return [];
  }

  const childGroups = pair.value.items.flatMap((child) => collectLeafGroups(child));
  if (childGroups.length > 0) {
    return childGroups;
  }

  return [{ name: stringifyKey(pair.key), seq: pair.value }];
}

function ensureServicesRoot(document: Document): YAMLSeq {
  if (!document.contents) {
    document.contents = document.createNode([]);
  }

  if (!isSeq(document.contents)) {
    throw new Error('Homepage services must be a YAML list.');
  }

  return document.contents;
}

function ensureDestinationGroup(document: Document, groupName: string): YAMLSeq {
  const root = ensureServicesRoot(document);
  const existing = collectLeafGroups(root).find((group) => group.name === groupName);
  if (existing) {
    return existing.seq;
  }

  const newGroup = document.createNode({ [groupName]: [] });
  root.add(newGroup);
  const created = collectLeafGroups(root).find((group) => group.name === groupName);
  if (!created) {
    throw new Error('Unable to create service group.');
  }

  return created.seq;
}

function getMosMap(tile: YAMLMap): YAMLMap | null {
  const mos = getMapValue(tile, 'mos');
  return isMap(mos) ? mos : null;
}

function getProxyMap(tile: YAMLMap): YAMLMap | null {
  const mos = getMosMap(tile);
  const proxy = mos ? getMapValue(mos, 'proxy') : null;
  return isMap(proxy) ? proxy : null;
}

function getServiceId(tile: YAMLMap): string {
  const mos = getMosMap(tile);
  return mos ? getMapString(mos, 'id') : '';
}

function isManagedExternalService(tile: YAMLMap): boolean {
  const mos = getMosMap(tile);
  return Boolean(mos && getMapString(mos, 'kind') === 'external' && getMapBoolean(mos, 'managed'));
}

function serviceFromLocation(location: ServiceTileLocation): HomepageExternalService | null {
  if (!isManagedExternalService(location.tile)) {
    return null;
  }

  const proxy = getProxyMap(location.tile);
  const tls = proxy ? getMapValue(proxy, 'tls') : null;

  return {
    description: getMapString(location.tile, 'description'),
    group: location.group,
    href: getMapString(location.tile, 'href'),
    icon: getMapString(location.tile, 'icon'),
    id: getServiceId(location.tile),
    proxyEnabled: proxy ? getMapBoolean(proxy, 'enabled') : false,
    title: stringifyKey(location.pair.key),
    upstream: proxy ? getMapString(proxy, 'upstream') : '',
    upstreamTlsInsecureSkipVerify: isMap(tls) ? getMapBoolean(tls, 'insecureSkipVerify') : false,
  };
}

function createServiceTile(document: Document, service: HomepageExternalService): YAMLMap {
  const tile: Record<string, unknown> = {
    href: service.href,
  };

  if (service.description) {
    tile.description = service.description;
  }

  if (service.icon) {
    tile.icon = service.icon;
  }

  tile.mos = {
    id: service.id,
    kind: 'external',
    managed: true,
    proxy: {
      enabled: service.proxyEnabled,
    },
  };

  if (service.proxyEnabled) {
    const proxy = (tile.mos as { proxy: Record<string, unknown> }).proxy;
    proxy.upstream = service.upstream;
    if (service.upstreamTlsInsecureSkipVerify) {
      proxy.tls = { insecureSkipVerify: true };
    }
  }

  return document.createNode({ [service.title]: tile }) as YAMLMap;
}

function applyServiceTile(document: Document, location: ServiceTileLocation, service: HomepageExternalService): void {
  const nextTileNode = createServiceTile(document, service);
  const index = location.parentSeq.items.indexOf(location.tileNode);
  if (index === -1) {
    throw new Error('Unable to update service.');
  }

  location.parentSeq.items[index] = nextTileNode;
}

function findServiceLocation(document: Document, id: string): ServiceTileLocation | null {
  const root = ensureServicesRoot(document);
  return collectServiceTileLocations(root).find((location) => getServiceId(location.tile) === id) || null;
}

function parseServicesDocument(content: string): Document {
  const document = parseDocument(content, { prettyErrors: true });
  const firstError = document.errors[0];
  if (firstError) {
    throw new Error(`Invalid YAML: ${firstError.message}`);
  }

  ensureServicesRoot(document);
  return document;
}

export class HomepageConfigService {
  private readonly config: SuiteManagerConfig;

  constructor(config: SuiteManagerConfig) {
    this.config = config;
  }

  listFiles(): HomepageConfigFile[] {
    return EDITABLE_FILES;
  }

  async readFile(name: string): Promise<{ content: string; file: HomepageConfigFile }> {
    await this.seedMissingFiles();
    const file = getFile(name);
    const content = await fs.readFile(resolveWithin(this.config.homepageConfigDir, file.name), 'utf8');
    return { content, file };
  }

  async writeFile(name: string, content: string): Promise<{ content: string; file: HomepageConfigFile }> {
    await this.seedMissingFiles();
    const file = getFile(name);
    validateConfigContent(file, content);
    if (file.name === 'services.template.yaml') {
      const validation = this.validateFileContent(file.name, content);
      if (!validation.valid) {
        const firstError = validation.errors[0];
        throw new Error(firstError ? `${firstError.path}: ${firstError.message}` : 'Homepage config validation failed.');
      }
    }
    await fs.writeFile(resolveWithin(this.config.homepageConfigDir, file.name), content, 'utf8');
    return { content, file };
  }

  async resetFile(name: string): Promise<{ content: string; file: HomepageConfigFile }> {
    const file = getFile(name);
    const defaultContent = await fs.readFile(resolveWithin(this.config.homepageDefaultConfigDir, file.name), 'utf8');
    return this.writeFile(file.name, defaultContent);
  }

  async exportFiles(): Promise<{ files: HomepageConfigExportFile[] }> {
    await this.seedMissingFiles();
    const files: HomepageConfigExportFile[] = [];

    for (const file of EDITABLE_FILES) {
      files.push({
        ...file,
        content: await fs.readFile(resolveWithin(this.config.homepageConfigDir, file.name), 'utf8'),
      });
    }

    return { files };
  }

  async getCaddyProxyPreview(): Promise<CaddyProxyPreview> {
    const { content } = await this.readFile('services.template.yaml');
    return createCaddyProxyPreviewFromServicesTemplate(content);
  }

  async listExternalServices(): Promise<HomepageExternalServicesResult> {
    const { content } = await this.readFile('services.template.yaml');
    const document = parseServicesDocument(content);
    const root = ensureServicesRoot(document);
    const groups = collectGroupNames(root);
    if (!groups.includes('My External Services')) {
      groups.push('My External Services');
    }

    return {
      defaultDomain: this.config.domain,
      defaultUrlScheme: this.config.urlScheme,
      groups,
      services: collectServiceTileLocations(root)
        .map((location) => serviceFromLocation(location))
        .filter((service): service is HomepageExternalService => Boolean(service)),
    };
  }

  async addExternalService(input: HomepageExternalServiceInput): Promise<HomepageExternalServicesResult> {
    const nextService = {
      ...normalizeExternalServiceInput(input),
      id: randomUUID(),
    };

    await this.updateServicesTemplate((document) => {
      const group = ensureDestinationGroup(document, nextService.group);
      group.add(createServiceTile(document, nextService));
    });

    return this.listExternalServices();
  }

  async updateExternalService(
    id: string,
    input: HomepageExternalServiceInput,
  ): Promise<HomepageExternalServicesResult> {
    const nextService = {
      ...normalizeExternalServiceInput(input),
      id,
    };

    await this.updateServicesTemplate((document) => {
      const location = findServiceLocation(document, id);
      if (!location || !isManagedExternalService(location.tile)) {
        throw new Error('External service not found.');
      }

      if (location.group === nextService.group) {
        applyServiceTile(document, location, nextService);
        return;
      }

      const index = location.parentSeq.items.indexOf(location.tileNode);
      if (index === -1) {
        throw new Error('Unable to move service.');
      }
      location.parentSeq.items.splice(index, 1);
      ensureDestinationGroup(document, nextService.group).add(createServiceTile(document, nextService));
    });

    return this.listExternalServices();
  }

  async removeExternalService(id: string): Promise<HomepageExternalServicesResult> {
    await this.updateServicesTemplate((document) => {
      const location = findServiceLocation(document, id);
      if (!location || !isManagedExternalService(location.tile)) {
        throw new Error('External service not found.');
      }

      const index = location.parentSeq.items.indexOf(location.tileNode);
      if (index === -1) {
        throw new Error('Unable to remove service.');
      }

      location.parentSeq.items.splice(index, 1);
    });

    return this.listExternalServices();
  }

  previewCaddyProxyContent(content: string): CaddyProxyPreview {
    return createCaddyProxyPreviewFromServicesTemplate(content);
  }

  validateFileContent(name: string, content: string): HomepageConfigValidation {
    const file = getFile(name);
    const errors = collectConfigValidationErrors(file, content);

    if (errors.length > 0) {
      return {
        caddyPreview: null,
        errors,
        valid: false,
      };
    }

    if (file.name === 'services.template.yaml') {
      const caddyPreview = createCaddyProxyPreviewFromServicesTemplate(content);
      return {
        caddyPreview,
        errors: caddyPreview.errors,
        valid: caddyPreview.valid,
      };
    }

    return {
      caddyPreview: null,
      errors: [],
      valid: true,
    };
  }

  private async seedMissingFiles(): Promise<void> {
    await fs.mkdir(this.config.homepageConfigDir, { recursive: true });

    for (const file of EDITABLE_FILES) {
      const targetPath = resolveWithin(this.config.homepageConfigDir, file.name);
      try {
        await fs.access(targetPath);
      } catch {
        const defaultContent = await fs.readFile(resolveWithin(this.config.homepageDefaultConfigDir, file.name), 'utf8');
        await fs.writeFile(targetPath, defaultContent, 'utf8');
      }
    }
  }

  private async updateServicesTemplate(mutator: (document: Document) => void): Promise<void> {
    const { content } = await this.readFile('services.template.yaml');
    const document = parseServicesDocument(content);
    mutator(document);

    const nextContent = document.toString();
    const validation = this.validateFileContent('services.template.yaml', nextContent);
    if (!validation.valid) {
      const firstError = validation.errors[0];
      throw new Error(firstError ? `${firstError.path}: ${firstError.message}` : 'External service validation failed.');
    }

    await this.writeFile('services.template.yaml', nextContent);
  }
}
