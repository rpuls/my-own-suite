export type CatalogProvisioningMode = 'automatic' | 'assisted' | 'manual' | 'unsupported-alpha';

export type CatalogApp = {
  category: string;
  compose: {
    profile: string;
    services: string[];
  };
  dependencies: Array<{
    id: string;
    kind: 'required' | 'recommended';
  }>;
  docs: {
    app: string;
  };
  homepage: {
    description: string;
    group: string;
    hrefEnv: string;
    icon?: string;
    name: string;
  } | null;
  id: string;
  installed: {
    installedAt: string | null;
    lastApply: {
      message: string | null;
      status: 'pending' | 'succeeded' | 'failed';
      updatedAt: string;
    } | null;
    status: 'not-installed' | 'pending-apply' | 'installing' | 'installed' | 'failed' | 'disabled';
  };
  name: string;
  provisioning: {
    mode: CatalogProvisioningMode;
    setupHelper: string | null;
  };
  routes: Array<{
    host: string;
    httpsInHttpMode?: boolean;
    upstream: string;
  }>;
  summary: string;
};

export type AppCatalogResponse = {
  apps: CatalogApp[];
  generatedAt: string;
};

export type AppCatalogInstallResponse = AppCatalogResponse & {
  composeSelection: {
    profiles: string[];
  };
  plan: {
    appId: string;
    composeProfile: string;
    composeServices: string[];
  };
};
