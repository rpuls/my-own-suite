import fs from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';

import type { SuiteManagerConfig } from '../../config.ts';

export type HomepageConfigFile = {
  description: string;
  generated: boolean;
  language: 'css' | 'javascript' | 'yaml';
  name: string;
};

const EDITABLE_FILES: HomepageConfigFile[] = [
  {
    description: 'Service groups and tiles. Saving this also regenerates services.yaml.',
    generated: false,
    language: 'yaml',
    name: 'services.template.yaml',
  },
  {
    description: 'Bookmarks shown by Homepage.',
    generated: false,
    language: 'yaml',
    name: 'bookmarks.yaml',
  },
  {
    description: 'Homepage widgets.',
    generated: false,
    language: 'yaml',
    name: 'widgets.yaml',
  },
  {
    description: 'Homepage settings.',
    generated: false,
    language: 'yaml',
    name: 'settings.yaml',
  },
  {
    description: 'Local visual overrides.',
    generated: false,
    language: 'css',
    name: 'custom.css',
  },
  {
    description: 'Local browser-side customization.',
    generated: false,
    language: 'javascript',
    name: 'custom.js',
  },
  {
    description: 'Homepage Docker integration settings.',
    generated: false,
    language: 'yaml',
    name: 'docker.yaml',
  },
  {
    description: 'Homepage Kubernetes integration settings.',
    generated: false,
    language: 'yaml',
    name: 'kubernetes.yaml',
  },
];

const PLACEHOLDER_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

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

function hasUnresolvedPlaceholders(value: string): boolean {
  PLACEHOLDER_REGEX.lastIndex = 0;
  return PLACEHOLDER_REGEX.test(value);
}

function replacePlaceholders(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(PLACEHOLDER_REGEX, (match, varName) => {
    const envValue = env[varName];
    if (envValue === undefined || envValue === '') {
      return match;
    }
    return envValue.replace(/^["']|["']$/g, '');
  });
}

function hasAnyUnresolvedPlaceholders(value: unknown): boolean {
  if (typeof value === 'string') {
    return hasUnresolvedPlaceholders(value);
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasAnyUnresolvedPlaceholders(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((item) => hasAnyUnresolvedPlaceholders(item));
  }

  return false;
}

function replacePlaceholdersInObject(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return replacePlaceholders(value, env);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholdersInObject(item, env));
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = replacePlaceholdersInObject(item, env);
    }
    return result;
  }

  return value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function processEntry(entry: unknown, env: NodeJS.ProcessEnv): unknown | null {
  if (!isObjectRecord(entry)) {
    const replaced = replacePlaceholdersInObject(entry, env);
    return hasAnyUnresolvedPlaceholders(replaced) ? null : replaced;
  }

  const pairs = Object.entries(entry);
  if (pairs.length !== 1) {
    const replaced = replacePlaceholdersInObject(entry, env);
    return hasAnyUnresolvedPlaceholders(replaced) ? null : replaced;
  }

  const [name, value] = pairs[0] as [string, unknown];
  if (Array.isArray(value)) {
    const children: unknown[] = [];
    for (const child of value) {
      const processed = processEntry(child, env);
      if (processed !== null) {
        children.push(processed);
      }
    }

    return children.length > 0 ? { [name]: children } : null;
  }

  const replacedLeaf = replacePlaceholdersInObject(entry, env);
  return hasAnyUnresolvedPlaceholders(replacedLeaf) ? null : replacedLeaf;
}

function processTemplate(template: unknown, env: NodeJS.ProcessEnv): unknown[] {
  const templateArray = Array.isArray(template) ? template : [template];
  const result: unknown[] = [];

  for (const entry of templateArray) {
    const processed = processEntry(entry, env);
    if (processed !== null) {
      result.push(processed);
    }
  }

  return result;
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
    if (!this.config.homepageConfigDir) {
      throw new Error('Homepage runtime config is not mounted into Suite Manager.');
    }

    const file = getFile(name);
    const content = await fs.readFile(resolveWithin(this.config.homepageConfigDir, file.name), 'utf8');
    return { content, file };
  }

  async writeFile(name: string, content: string): Promise<{ content: string; file: HomepageConfigFile }> {
    if (!this.config.homepageConfigDir) {
      throw new Error('Homepage runtime config is not mounted into Suite Manager.');
    }

    const file = getFile(name);
    await fs.mkdir(this.config.homepageConfigDir, { recursive: true });
    await fs.writeFile(resolveWithin(this.config.homepageConfigDir, file.name), content, 'utf8');

    if (file.name === 'services.template.yaml') {
      await this.generateServices();
    }

    return { content, file };
  }

  async resetFile(name: string): Promise<{ content: string; file: HomepageConfigFile }> {
    if (!this.config.homepageDefaultConfigDir) {
      throw new Error('Homepage default config is not mounted into Suite Manager.');
    }

    const file = getFile(name);
    const defaultContent = await fs.readFile(resolveWithin(this.config.homepageDefaultConfigDir, file.name), 'utf8');
    return this.writeFile(file.name, defaultContent);
  }

  async generateServices(): Promise<void> {
    if (!this.config.homepageConfigDir) {
      throw new Error('Homepage runtime config is not mounted into Suite Manager.');
    }

    const templateContent = await fs.readFile(
      resolveWithin(this.config.homepageConfigDir, 'services.template.yaml'),
      'utf8',
    );
    const processed = processTemplate(parse(templateContent), process.env);
    await fs.writeFile(
      resolveWithin(this.config.homepageConfigDir, 'services.yaml'),
      stringify(processed, {
        indent: 4,
        lineWidth: 0,
      }),
      'utf8',
    );
  }
}
