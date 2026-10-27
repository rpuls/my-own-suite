export type UpdateCheckpoint = {
  backupId: string | null;
  jobId: string | null;
  requested: boolean;
  status: string | null;
  target: string | null;
  waiting: { reason: string; since: string | null } | null;
};

export type UpdateJob = {
  checkpoint: UpdateCheckpoint | null;
  error: string | null;
  id: string;
  logs?: Array<{ at?: string; message?: string }>;
  output?: string | null;
  stage: string | null;
  status: string | null;
  updatedAt: string | null;
};

export function isRunning(job: UpdateJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

// The agent's stages, folded into the four an owner can follow.
export const PROGRESS_STEPS = ['Backup', 'Download', 'Build', 'Restart'];
const STAGE_STEP: Record<string, number> = {
  checking: 1,
  'ready-to-apply': 1,
  'updating-checkout': 1,
  'installing-dependencies': 2,
  'building-frontend': 2,
  'reconciling-system': 3,
  succeeded: 4,
};

export function progressStep(stage: string | null) {
  return STAGE_STEP[stage || ''] ?? 0;
}

// The Updates screen says it started one, so every page's hold looks at once instead of at its next poll.
export const UPDATE_STARTED_EVENT = 'mos-update-started';
