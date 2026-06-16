export type CatalogProvisioningMode = 'automatic' | 'assisted' | 'manual' | 'unsupported-alpha';

export type CatalogRoute = {
  host: string;
  httpsInHttpMode?: boolean;
  upstream: string;
};

export type CatalogInternalRoute = {
  asset: string;
  id: string;
};

export type CatalogHomepageTile = {
  description: string;
  group: string;
  hrefEnv: string;
  icon?: string;
  name: string;
} | null;

export type CatalogHomepageContributions = {
  services: string[];
  widgets: string[];
};

export type CatalogEnvProjection = {
  key: string;
  serviceEnv: string;
  value: string;
};

export type CatalogDoctorCheck = {
  allowTemplate?: string;
  message: string;
  sourceKey: string;
  sourceServiceEnv: string;
  targetKey: string;
  targetServiceEnv: string;
  type: 'envIncludesEnv';
};

export type CatalogDoctor = {
  checks: CatalogDoctorCheck[];
  homepageUrls: Array<{
    host: string;
    key: string;
  }>;
  requiredEnv: string[];
  serviceEnv: string;
} | null;

export type CatalogDependency = {
  id: string;
  kind: 'required' | 'recommended';
};

export type CatalogSetupHelper = {
  backend: string | null;
  frontend: string | null;
  id: string;
} | null;

export type CatalogAppManifest = {
  backup: {
    includeVolumes: string[];
    restoreNotes?: string;
  };
  category: string;
  compose: {
    envTemplates: string[];
    profile: string;
    services: string[];
    volumes: string[];
  };
  dependencies?: CatalogDependency[];
  doctor: CatalogDoctor;
  docs: {
    app: string;
  };
  env: {
    projections: CatalogEnvProjection[];
  };
  homepage: CatalogHomepageTile;
  homepageContributions: CatalogHomepageContributions;
  id: string;
  lifecycle: {
    installable: boolean;
  };
  name: string;
  package: {
    dir: string;
    source: string;
  };
  provisioning: {
    mode: CatalogProvisioningMode;
    postInstallActionLabel: string | null;
    setupHelper: CatalogSetupHelper;
  };
  routeContributions: {
    internal: CatalogInternalRoute[];
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
  homepageContributions: CatalogHomepageContributions;
  routeHosts: string[];
  routeInternalAssets: CatalogInternalRoute[];
  routes: CatalogRoute[];
  volumes: string[];
};
