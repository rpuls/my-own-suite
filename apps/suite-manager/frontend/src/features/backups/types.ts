export type BackupJobSummary = {
  destinationId: string | null;
  error: string | null;
  id: string;
  logs?: Array<{ at?: string; message?: string }>;
  outputPath: string | null;
  stage: string | null;
  status: string | null;
  updatedAt: string | null;
};

export type BackupDestination = {
  availableBytes: number | null;
  id: string;
  label: string;
  mountPath: string;
  sizeBytes: number | null;
  transport: string | null;
  writable: boolean;
};

export type BackupsStatus = {
  checkedAt: string;
  currentJob: BackupJobSummary | null;
  destinations: BackupDestination[];
  error: string | null;
  lastJob: BackupJobSummary | null;
  restorePlanAvailable: boolean;
  serviceAvailable: boolean;
  startBackupAvailable: boolean;
};
