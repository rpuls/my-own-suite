export type UpdatesStatus = {
  changeSummary: {
    items: string[];
    source: string | null;
    title: string;
  };
  currentJob: {
    error: string | null;
    id: string;
    logs?: Array<{ at?: string; message?: string }>;
    stage: string | null;
    status: string | null;
    target: string | null;
    updatedAt: string | null;
  } | null;
  checkedAt: string;
  error: string | null;
  installedVersion: string | null;
  installedVersionSource: string | null;
  latestRelease: {
    channel: string | null;
    notesUrl: string | null;
    publishedAt: string | null;
    source: 'github-release' | 'local-manifest' | 'override' | 'unavailable';
    version: string | null;
  };
  latestRevision: string | null;
  managedApplyAvailable: boolean;
  serviceAvailable: boolean;
  track: {
    currentBranch: string | null;
    currentCommit: string | null;
    label: string | null;
    ref: string | null;
    type: 'stable' | 'branch' | null;
  };
  trackConfigurationAvailable: boolean;
  updateAvailable: boolean;
};
