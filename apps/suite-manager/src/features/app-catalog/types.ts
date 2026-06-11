export type CatalogProvisioningMode = 'automatic' | 'assisted' | 'manual' | 'unsupported-alpha';

export type CatalogRoute = {
  host: string;
  httpsInHttpMode?: boolean;
  upstream: string;
};

export type CatalogHomepageTile = {
  description: string;
  group: string;
  hrefEnv: string;
  icon?: string;
  name: string;
} | null;

export type CatalogDependency = {
  id: string;
  kind: 'required' | 'recommended';
};

export type CatalogAppManifest = {
  backup: {
    includeVolumes: string[];
  };
  category: string;
  compose: {
    envTemplates: string[];
    profile: string;
    services: string[];
    volumes: string[];
  };
  dependencies?: CatalogDependency[];
  docs: {
    app: string;
  };
  homepage: CatalogHomepageTile;
  id: string;
  name: string;
  provisioning: {
    mode: CatalogProvisioningMode;
    setupHelper: string | null;
  };
  routes: CatalogRoute[];
  summary: string;
};

export type CatalogControlPlaneManifest = {
  components: Array<{
    composeServices: string[];
    envTemplates: string[];
    id: string;
    name: string;
    volumes: string[];
  }>;
  hostAgents: string[];
  id: 'control-plane';
  name: string;
};

export type CatalogManifestSet = {
  apps: CatalogAppManifest[];
  controlPlane: CatalogControlPlaneManifest;
};

export type InstalledCatalogApp = {
  appId: string;
  installedAt: string;
  installPlan: CatalogInstallPlan | null;
  lastApply: {
    message: string | null;
    status: 'pending' | 'succeeded' | 'failed';
    updatedAt: string;
  } | null;
  manifestVersion: number;
  routeHosts: string[];
  serviceNames: string[];
  status: 'pending-apply' | 'installing' | 'installed' | 'failed' | 'disabled';
  volumeNames: string[];
};

export type InstalledCatalogState = {
  apps: InstalledCatalogApp[];
  updatedAt: string | null;
  version: 1;
};

export type CatalogInstallPlan = {
  appId: string;
  backupVolumes: string[];
  composeProfile: string;
  composeServices: string[];
  envTemplates: string[];
  homepage: CatalogHomepageTile;
  routeHosts: string[];
  routes: CatalogRoute[];
  volumes: string[];
};
