export type UpdatesStatus = {
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
  updateAvailable: boolean;
};
