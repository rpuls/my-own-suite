import type { InstanceConfigEntry, OwnerEnvEntry, SetupField } from './AppConfigDialog';
import type { ProgressStep } from './ProgressSteps';
import type { PrivacyAdvisory, PrivacyReviewSummary } from './privacy-posture';

// What one service needs. The resting pair is always present when the package
// declares anything; the peaks are stated only where a service has a heavy job
// to do, so absent means "no meaningful peak", not "unknown".
export type ServiceRequires = { cpuCores: number; cpuPeakCores: number | null; memoryMb: number; memoryPeakMb: number | null };

type CatalogFeature = { body: string; title: string };

type CatalogLinkKey = 'docs' | 'repository' | 'website';

type CatalogMetadata = {
  description: string;
  features: CatalogFeature[];
  links: Partial<Record<CatalogLinkKey, string>>;
  privacy: { notes: string[]; summary: string };
  related: string[];
  replaces: string[];
  resourceHint: { description: string; label: string; level: string };
  screenshots: Array<{ alt: string; caption: string; src: string }>;
  tags: string[];
};

export type CatalogStatus = { advisories?: { error: { code: string; message: string } | null; fetchedAt: string | null; freshness: 'fresh' | 'stale' | 'unavailable'; revision: string | null }; error: { code: string; message: string } | null; fetchedAt: string | null; freshness: 'fresh' | 'stale' | 'unavailable'; ref: string | null; repository: string; revision: string | null };

type CatalogUpdate = {
  // A checkout candidate has no fetched revision of its own, so `sourceRevision` is
  // null there.
  available: { appVersion: string; compatibility: 'compatible' | 'requires-platform-update'; minimumMosVersion: string; packageDigest: string; packageVersion: string; privacy: { status: string }; sourceChannel?: 'added-source' | 'catalog' | 'checkout'; sourceRevision: string | null } | null;
  installed: { packageDigest: string; packageVersion: string } | null;
  // When MOS last read the added source's listing; null on every other channel.
  sourceCheckedAt?: string | null;
  // `external-source` means the app came from a pasted repository and its source's
  // last listing offers nothing newer than what is installed.
  status: 'current' | 'external-source' | 'installable' | 'installed-newer' | 'not-in-catalog' | 'unavailable' | 'update-available';
};

export type UpdateComparison = {
  candidate: { appVersion: string | null; packageVersion: string; privacy: PrivacyReviewSummary };
  changes: Array<{ area: string; classification: string; summary: string }>;
  compatibility: 'compatible' | 'owner-action-required' | 'unsupported' | 'unresolved';
  // Binds an apply to the exact pair of packages that were compared here. The
  // backend re-compares and refuses the apply if either side moved since.
  confirmationToken: string;
  installed: { appVersion: string | null; packageVersion: string; privacy: PrivacyReviewSummary };
  metadata: { backupRequired: boolean; downtime: string; migrations: string[]; ownerActions: string[]; rollback: string };
  // What the candidate asks MOS for, and what it asks for that the installed
  // version does not already have.
  permissions: { added: string[]; candidate: string[]; installed: string[]; removed: string[] };
  requiredInput: Array<{ default?: unknown; id: string; label: string; secret: boolean; type: string }>;
  // Capabilities the candidate needs that nothing here provides, with what would.
  requirements: Array<{ providers: Array<{ action: 'install' | 'update'; id: string; name: string; version: string }>; type: string }>;
  updateStatus: 'current' | 'installed-newer' | 'update-available';
  validation: { errors: string[] };
};

export type UnmetRequirement = { id: string; reason: string };

export type AppPackageSummary = {
  // The app's own version, as its manifest declares it; `version` below is the
  // MOS package version.
  appVersion: string | null;
  installJob?: AppJob<InstallStep> | null;
  updateJob?: AppJob<UpdateStep> | null;
  capabilities: {
    exports: Array<{ features: Record<string, unknown>; id: string; implementation: string; interfaceVersion: number | null; protocol: string; title: string; type: string }>;
    integrations: Array<{ accepts: Array<{ interfaceVersion: number | null; protocol: string; type: string }>; id: string; title: string }>;
    usefulness: { emptyState: string; requiresOneOf: string[] };
  };
  catalog: CatalogMetadata;
  catalogUpdate: CatalogUpdate | null;
  category: string | string[];
  compatibility?: {
    connectedBy: Array<{ id: string; name: string; status: string }>;
    connections: Array<{
      actionLabel: string;
      capabilityId: string;
      consumerPackageId: string;
      provider: { id: string; installStatus: string; name: string; runtimeState: string };
      ready: boolean;
      relationship: { id: string; lastErrorCode: string | null; status: string; updatedAt: string } | null;
      slotId: string;
      title: string;
    }>;
    missingUsefulPeers: Array<{ message: string; type: string }>;
  };
  health: { type: string | null; url: string | null } | null;
  homepage: { description: string; group: string; icon: string; name: string } | null;
  icon: string;
  // Set only on a card an added source offers, where there is no icon file
  // on this server to serve.
  iconDataUrl?: string | null;
  iconUrl: string;
  // Where the installed app is really served; empty when nothing answers yet.
  publicUrl: string;
  instance: {
    config?: InstanceConfigEntry[];
    enabled: boolean;
    // Environment variables the owner set on this instance, never the package.
    // A hidden one carries a fingerprint and a label instead of its value.
    env?: OwnerEnvEntry[];
    guideState?: { completedAt: string | null; firstViewedAt: string | null; manifestDigest: string; skippedAt: string | null; status: 'not-started' | 'viewed' | 'completed' | 'skipped'; updatedAt: string } | null;
    id: string;
    installedAt: string;
    // The last operation on this app, if it failed and nothing has succeeded
    // since. Present so the screen can say what went wrong instead of leaving
    // the owner with a status that never changed and no reason.
    lastFailure?: { completedAt: string | null; diagnostics: string | null; errorCode: string | null; kind: string; startedAt: string } | null;
    packageId: string;
    packageVersion: string;
    projections: Array<{ appliedDigest: string | null; content: unknown; digest: string; kind: string; status: string; updatedAt?: string }>;
    status: string;
    updateRecovery?: { errorCode: string; state: 'retry-safe' | 'rollback-required' | 'commit-required' } | null;
    updatedAt?: string;
  } | null;
  advisories?: PrivacyAdvisory[];
  // Trust of the source this instance was installed from, reported by the
  // backend and never derived from package metadata.
  external?: boolean;
  id: string;
  installStatus: string;
  mosReviewed?: boolean;
  // Why MOS will not install an offered external package. Present only on a card
  // an added source publishes that failed validation.
  packageErrors?: string[];
  // The added source this app came from. An offered package carries its source
  // record — installing it means re-resolving that repository rather than reading
  // a package this MOS already holds — and an installed external app carries its
  // repository alone, which is what names its publisher once there is no source
  // record to read. Absent entirely on a catalog app.
  source?: { id?: string; publisher?: string | null; repository: string };
  name: string;
  privacy: PrivacyReviewSummary;
  onboarding?: {
    sections?: Array<{
      actionLabel?: string;
      body?: string;
      choices?: Array<{ id: string; label: string; steps: string[] }>;
      id: string;
      steps?: string[];
      title: string;
      type: string;
      values?: Array<{ copy: boolean; label: string; value: string }>;
    }>;
    summary?: string;
    title?: string;
  };
  routes: Array<{ host: string; kind: 'web' | 'api'; service: string }>;
  role: 'standalone' | 'capability-provider' | string;
  services: Array<{ dockerfile: string | null; id: string; internalPort: number | null; requires: ServiceRequires | null; volumes: string[] }>;
  setup: { fieldCount: number; fields: SetupField[] };
  summary: string;
  // What this server lacks that the app needs, each with the reason to show.
  unmetRequirements: UnmetRequirement[];
  validation: { errors: string[]; valid: boolean };
  version: string;
};

// A pasted repository URL resolves to one unverified preview card per app package
// the repository publishes. The card reuses the public package summary shape, plus
// explicit external/trust flags, the package's own inlined icon, and what it would
// ask MOS for; nothing is persisted by resolving.
//
// `id` is the source-namespaced id every API path addresses the package by;
// `packageId` is the bare id its own manifest claims, shown only as a fact.
export type ExternalCard = Pick<AppPackageSummary,
  'appVersion' | 'capabilities' | 'catalog' | 'category' | 'health' | 'homepage' | 'icon' | 'id' | 'name' | 'role' | 'routes' | 'services' | 'setup' | 'summary' | 'unmetRequirements' | 'validation' | 'version'> & {
  external: true;
  iconDataUrl: string | null;
  iconUrl: string;
  installStatus: string;
  minimumMosVersion: string;
  mosReviewed: false;
  packageDigest: string | null;
  // Why MOS will not install this one. A package a source publishes but cannot
  // install is listed with its reasons rather than hidden, so the owner can see it
  // is offered and its publisher can see what to fix.
  packageErrors: string[];
  packageId: string;
  permissions: string[];
  trust: string;
};

export type ExternalSourceCoordinates = { catalogPath: string; id: string; kind: string; repository: string; revision: string; trust: string };

export type ExternalResolveResponse = {
  // Whether this repository is already one of the owner's added sources.
  added: boolean;
  packages: ExternalCard[];
  source: ExternalSourceCoordinates;
};

export type InstallStep = ProgressStep & { id: 'prepare' | 'runtime' | 'address' | 'homepage' | 'ready' };

export type UpdateStep = ProgressStep & { id: 'check' | 'build' | 'switch' | 'finish' };

// An install or update the server runs, read back from the app list.
export type AppJob<Step extends ProgressStep> = {
  error: { code: string; message: string } | null;
  notice?: { detail: string; message: string } | null;
  startedAt: string;
  status: 'failed' | 'running' | 'succeeded';
  steps: Array<{ id: Step['id']; seconds?: number; status: ProgressStep['status'] }>;
};
