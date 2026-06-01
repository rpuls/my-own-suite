export type HomepageConfigFile = {
  description: string;
  generated: boolean;
  language: 'css' | 'javascript' | 'yaml';
  name: string;
};

export type HomepageConfigListResponse = {
  files: HomepageConfigFile[];
};

export type HomepageConfigFileResponse = {
  content: string;
  file: HomepageConfigFile;
};

export type HomepageConfigCapabilitiesResponse = {
  error: string | null;
  homepageRestartAvailable: boolean;
  serviceAvailable: boolean;
};

export type HomepageRestartResponse = {
  restarted: boolean;
};

export type HomepageCaddyProxyPreviewError = {
  message: string;
  path: string;
};

export type HomepageCaddyProxyPreviewRoute = {
  host: string;
  href: string;
  path: string;
  title: string;
  upstream: string;
  upstreamTlsInsecureSkipVerify: boolean;
};

export type HomepageCaddyProxyPreviewResponse = {
  caddyfile: string;
  errors: HomepageCaddyProxyPreviewError[];
  routes: HomepageCaddyProxyPreviewRoute[];
  valid: boolean;
};
