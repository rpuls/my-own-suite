import type { SuiteManagerConfig } from '../../../../../src/config.ts';
import type { CatalogAppManifest } from '../../../../../src/features/app-catalog/types.ts';
import type { CatalogSetupHelperResponse } from '../../../../../src/features/app-catalog/setup-helper-registry.ts';

type CreateSetupHelperInput = {
  app: CatalogAppManifest;
  config: SuiteManagerConfig;
};

function radicaleCollectionUrl(config: SuiteManagerConfig): string {
  const username = config.generatedAccounts.radicale?.username || 'admin';
  const baseUrl = config.appUrls.radicale.replace(/\/$/, '');
  return `${baseUrl}/${encodeURIComponent(username)}/`;
}

export function createSetupHelper({ app, config }: CreateSetupHelperInput): CatalogSetupHelperResponse {
  return {
    fields: {
      password: config.generatedAccounts.radicale?.password || '',
      serverUrl: radicaleCollectionUrl(config),
      username: config.generatedAccounts.radicale?.username || 'admin',
    },
    id: app.provisioning.setupHelper?.id || 'radicale-device-setup',
    title: 'Calendar setup',
  };
}
