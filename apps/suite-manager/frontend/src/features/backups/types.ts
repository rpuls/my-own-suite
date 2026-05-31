export type BackupJobSummary = {
  backupPath: string | null;
  destinationId: string | null;
  error: string | null;
  id: string;
  kind: string | null;
  logs?: Array<{ at?: string; message?: string }>;
  outputPath: string | null;
  rescuePath: string | null;
  stage: string | null;
  status: string | null;
  updatedAt: string | null;
};

export type BackupDestination = {
  availableBytes: number | null;
  devicePath?: string | null;
  fileSystem?: string | null;
  id: string;
  label: string;
  mountPath: string | null;
  mountState?: 'mounted' | 'unmounted' | 'unsupported-mount';
  sizeBytes: number | null;
  transport: string | null;
  writable: boolean;
};

export type BackupBundle = {
  activeProfiles: string[];
  createdAt: string | null;
  destinationId: string;
  destinationLabel: string;
  id: string;
  path: string;
  schemaVersion: number | null;
  sourceCommit: string | null;
  sourceVersion: string | null;
  totalVolumeArchiveBytes: number;
  volumeCount: number;
};

export type BackupsStatus = {
  backups: BackupBundle[];
  checkedAt: string;
  currentJob: BackupJobSummary | null;
  destinations: BackupDestination[];
  error: string | null;
  lastJob: BackupJobSummary | null;
  restorePlanAvailable: boolean;
  restoreApplyAvailable: boolean;
  serviceAvailable: boolean;
  startBackupAvailable: boolean;
};
