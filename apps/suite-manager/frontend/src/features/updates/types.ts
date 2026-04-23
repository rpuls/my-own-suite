export type UpdatesStatus = {
  currentJob: {
    error: string | null;
    id: string;
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
  mode: 'managed' | 'notify-only';
  serviceAvailable: boolean;
  track: {
    currentBranch: string | null;
    currentCommit: string | null;
    label: string | null;
    ref: string | null;
    type: 'stable' | 'branch' | null;
  };
  updateAvailable: boolean;
};
