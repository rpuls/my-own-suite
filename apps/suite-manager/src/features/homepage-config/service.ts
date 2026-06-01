import fs from 'node:fs/promises';
import path from 'node:path';

import { parseDocument } from 'yaml';

import type { SuiteManagerConfig } from '../../config.ts';
import {
  createCaddyProxyPreviewFromServicesTemplate,
  type CaddyProxyPreview,
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

function validateConfigContent(file: HomepageConfigFile, content: string): void {
  if (file.language !== 'yaml') {
    return;
  }

  const document = parseDocument(content, { prettyErrors: true });
  const firstError = document.errors[0];
  if (firstError) {
    throw new Error(`Invalid YAML in ${file.name}: ${firstError.message}`);
  }
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

  previewCaddyProxyContent(content: string): CaddyProxyPreview {
    return createCaddyProxyPreviewFromServicesTemplate(content);
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
}
