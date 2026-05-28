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
