import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { SuiteManagerConfig } from '../../config.ts';
import type { CatalogAppManifest } from './types.ts';

export type CatalogSetupHelperResponse = {
  fields: {
    password?: string;
    serverUrl: string;
    username: string;
  };
  id: string;
  title: string;
};

type CatalogSetupHelperModule = {
  createSetupHelper: (input: {
    app: CatalogAppManifest;
    config: SuiteManagerConfig;
  }) => CatalogSetupHelperResponse | Promise<CatalogSetupHelperResponse | null> | null;
};

export async function getCatalogSetupHelper(
  app: CatalogAppManifest,
  config: SuiteManagerConfig,
): Promise<CatalogSetupHelperResponse | null> {
  const setupHelper = app.provisioning.setupHelper;
  if (!setupHelper?.backend) {
    return null;
  }

  const helperModulePath = path.join(app.package.dir, setupHelper.backend);
  const helperModule = await import(pathToFileURL(helperModulePath).href) as CatalogSetupHelperModule;
  return helperModule.createSetupHelper({ app, config });
}
