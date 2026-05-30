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
