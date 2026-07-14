# App Package Sources And Independent Updates Refactor Plan

> Temporary branch implementation plan. GitHub Issues remain the long-term source of task state. Remove this file or replace it with pointers to shipped documentation and issues before merging the completed refactor.

## Outcome

MOS app packages update independently from MOS platform releases. The official repository contains only the latest available package for each app. Every installation preserves the exact package snapshot it installed or last updated and uses that snapshot for settings, lifecycle operations, privacy posture, backup, and restore. MOS periodically checks configured package sources for newer candidates and can later install constrained, explicitly unverified external packages through the same source contract.

The defining rule is:

> Installed behavior comes from the installed package snapshot. Source repositories provide candidates, never live runtime truth.

## Scope

This refactor covers:

- independent MOS app-package versions;
- official catalog discovery from Git;
- immutable source revision and package-digest verification;
- persisted installed, candidate, and optionally previous package snapshots;
- installed-versus-available package presentation;
- candidate validation and breaking-change metadata;
- transactional per-app updates;
- version-matched privacy posture and advisories;
- backup/restore of installed package identity;
- a shared source mechanism for future external packages;
- explicit trust levels and capability restrictions.

It does not initially provide:

- unattended automatic app updates;
- a permanent public archive of every package version;
- guaranteed rollback across irreversible data migrations;
- arbitrary Compose, Docker, Caddy, host mounts, systemd, or root scripts in external packages;
- MOS certification of third-party package claims;
- retention of every historical locally built image.

## Current implementation evidence

The refactor must account for these current contracts:

- `suite-manager/backend/src/apps/package-manifest.cjs` discovers and validates folders directly under the configured repository `appsDir`.
- `AppPackageService.listPackages()` combines those current source manifests with SQLite instance rows. Installed app detail therefore inherits current repository presentation rather than an immutable installed package definition.
- `AppPackageService.installPackage()` stores `packageVersion` and `manifestDigest`, but not the manifest, setup schema, privacy assessment, source revision, package digest, or runtime assets.
- Runtime projections currently use `apps/<id>` as the build context.
- `system-agents/apps/system-adapter.cjs` builds from `appsRoot/<packageId>`, so reapply after a repository update can build different code than the installed instance originally used.
- Locally built image tags include `packageVersion`, but container labels do not record source revision or package digest.
- `BackupInventoryService` rediscovers current repository manifests instead of installed snapshots.
- The backup archive captures Suite Manager state and volumes, but it does not define installed package snapshots as a restore artifact.
- The core managed updater explicitly warns that repository app changes require manual reapply. Independent package updates must replace that incomplete behavior rather than add a second competing reconciliation path.

## Version identities

Keep three independent identifiers:

| Identity | Example | Advances when |
| --- | --- | --- |
| MOS platform version | `0.3.0` | Suite Manager, agents, installer, or shared contracts release |
| MOS app-package version | `1.4.1` | MOS packaging, configuration, artifacts, migrations, or assessment changes |
| Upstream component version | `2.6.1` | The upstream project publishes a component |

Package semver describes the MOS package contract:

- Patch: backward-compatible packaging, configuration, artifact, or assessment correction.
- Minor: normal upstream update or compatible package capability addition.
- Major: owner action, incompatible configuration, unsupported direct upgrade, or other package-contract break.

The update workflow must justify the package-version bump. A candidate also declares `minimumMosVersion`; requiring a new platform capability is the exception that couples an app update to a platform update.

## Source and trust model

Every package source resolves to a catalog plus package folder at one immutable revision.

Initial source kinds:

- `official-git`: the MOS repository and reviewed catalog;
- `external-git`: a user-added repository/catalog URL;
- `local`: deterministic development and tests only.

Trust is independent of source transport:

- `mos-reviewed`: accepted only from the configured official source and review process;
- `publisher-signed`: signature is trusted, but MOS has not reviewed the package;
- `unverified`: structurally valid package fetched from a manually supplied source.

Schema validation never promotes trust. Package-provided privacy claims must remain separate from a MOS review.

## Proposed source records

An installed instance records at least:

```json
{
  "packageId": "immich",
  "packageVersion": "1.4.0",
  "packageDigest": "sha256:...",
  "source": {
    "kind": "official-git",
    "repository": "https://github.com/rpuls/my-own-suite",
    "path": "apps/immich",
    "revision": "full-git-commit",
    "trust": "mos-reviewed"
  },
  "minimumMosVersion": "0.2.0"
}
```

The official catalog should be a small deterministic index, such as `apps/catalog.json`:

```json
{
  "schemaVersion": 1,
  "revision": "full-git-commit",
  "packages": {
    "immich": {
      "path": "apps/immich",
      "packageVersion": "1.4.0",
      "packageDigest": "sha256:...",
      "minimumMosVersion": "0.2.0"
    }
  }
}
```

Do not hand-maintain the revision inside the committed source file if that creates a self-referential commit problem. The fetcher may attach the resolved Git revision to the downloaded catalog envelope after retrieval. Define precisely which files and normalized metadata contribute to `packageDigest`; exclude transient files and forbid symlinks/path traversal.

## Snapshot layout

Use a host-owned root outside the moving repository checkout. Final paths should follow installer conventions, but the logical layout is:

```text
<state-root>/app-packages/<instance-id>/
  installed/
    manifest.json
    privacy-review.json
    Dockerfile...
    runtime assets...
    source.json
    package-digest
  candidate/
  previous/
```

Rules:

- `installed` is immutable between successful install/update transactions.
- Normal settings, projections, restart, Stop, Uninstall, backup inventory, and integration reconciliation read `installed`.
- `candidate` is never used for running operations before validation and confirmed update apply.
- `previous` is optional and bounded to one snapshot; it is not a promise of data rollback.
- Promotion uses same-filesystem atomic rename after runtime health and state persistence succeed.
- Failed or interrupted downloads never alter `installed`.
- Uninstall removes snapshots only as part of the existing explicitly destructive uninstall transaction.

## Package contents and capabilities

Define a package allowlist rather than accepting arbitrary repository contents. Initially allow:

- `manifest.json`;
- `privacy-review.json` when MOS-reviewed posture is claimed;
- root-level `Dockerfile` and `Dockerfile.<service>` files referenced by the manifest;
- declared runtime assets needed by those Dockerfiles;
- catalog icon and narrowly constrained presentation assets;
- technical README for source transparency, not runtime execution.

Reject symlinks, path traversal, undeclared executable hooks, raw Compose/Caddy, and files outside size/count limits.

Add explicit package permissions/capabilities. Unverified packages must initially forbid:

- privileged containers and host networking;
- Docker socket access;
- arbitrary host paths or device mounts;
- raw Caddy directives;
- systemd or host-agent installation;
- access to other package secrets or volumes;
- arbitrary root lifecycle scripts;
- undeclared public ports or cross-package networks.

## Privacy and advisory model

- `privacy-review.json` binds to the candidate package version, package digest, source revision, upstream components, and artifact digests.
- Install/update copies it into `installed`; the Apps UI displays that review for the running package.
- The candidate review appears only in update comparison until apply.
- `mos-reviewed` posture requires a valid MOS assessment. External packages may expose publisher claims, but the UI labels them as publisher-provided.
- Policy or newly discovered behavior that affects installed versions uses a lightweight advisory feed with package-version ranges and a status such as `privacy-review-invalidated`.
- Advisories do not require retaining complete historical package folders.

## Update transaction

The target sequence is:

1. Refresh cached catalog metadata.
2. Resolve the source reference to an immutable revision.
3. Download the candidate into a new temporary directory.
4. Enforce transport limits, safe paths, file allowlist, and source trust.
5. Validate manifest, privacy assessment, package digest, platform compatibility, and declared capabilities.
6. Compare installed and candidate manifests/config schemas.
7. Present versions, privacy change, breaking changes, owner actions, backup requirement, downtime, and rollback limitations.
8. Obtain explicit owner confirmation.
9. Create required pre-update backup/checkpoint where supported.
10. Migrate a copy of settings; request new required values before stopping the running app.
11. Build candidate images from the candidate snapshot using package-digest-qualified tags.
12. Stop/replace runtime while preserving declared volumes.
13. Validate health, routes, Homepage, and integrations.
14. Persist new projections, source identity, settings, and installed snapshot.
15. Atomically promote candidate and retain the prior snapshot only if useful.
16. On failure, restore the previous runtime where technically safe and report the exact recovery state.

Never report success while the instance row, installed snapshot, images/containers, routes, and integrations disagree.

## Phased implementation checklist

### Phase 0 — contract fixtures and decisions

- [x] Define the package-source, catalog, installed-snapshot, advisory, and update-comparison schemas.
- [x] Add `minimumMosVersion`, source/trust metadata, and package privacy summary to the package/catalog contracts.
- [x] Define deterministic package hashing, including line endings, file ordering, allowed files, size limits, and symlink rejection.
- [x] Add representative official, external-unverified, malformed, incompatible, and privacy-invalidated fixtures.
- [x] Add a catalog generator/checker so committed catalog metadata cannot drift from app manifests.
- [x] Update all three repository skills to reference the package catalog and privacy binding commands.
- [x] Decide the host snapshot root and permissions.
- [x] Decide catalog refresh defaults, backoff, cache lifetime, and manual Refresh behavior.
- [x] Record open security and rollback limitations in release notes.

Acceptance:

- [x] A deterministic test normalizes Windows and Linux checkout line endings to the same package digest.
- [x] Invalid paths, files, trust claims, privacy bindings, and platform requirements fail closed in the Phase 0 contract validators.
- [x] Existing official packages can be represented in the generated catalog without app-specific core code.

### Phase 1 — installed snapshot foundation

- [x] Add SQLite source identity, package digest, snapshot path/state, and installed assessment summary through a migration.
- [x] Add a narrow host-agent snapshot capability that copies only validated package files into the host-owned root.
- [x] During new install, validate and persist the snapshot before creating configuration or runtime projections.
- [x] Change projection rendering and runtime apply to load the installed snapshot.
- [x] Pass an explicit validated build context/snapshot identity to the app agent; stop deriving it from `appsRoot/<packageId>`.
- [x] Tag and label images/containers with package version, package digest, and source revision.
- [x] Change restart, enable, Stop, Uninstall, integration reconciliation, icon serving, and setup guides to use installed package data where an instance exists.
- [x] Preserve repo discovery only for not-yet-installed catalog candidates.
- [x] Migrate existing installed instances by snapshotting the current matching repo package only when manifest version/digest agrees; otherwise mark `needs-package-recovery` instead of guessing.

Acceptance:

- [x] Editing the repository manifest/Dockerfile after install does not change installed app detail, settings, restart build context, or privacy posture.
- [x] A missing repository checkout does not prevent management of an already-installed app.
- [x] Snapshot creation is atomic and rejects partial copies.
- [x] Existing instances migrate truthfully or enter an actionable recovery state.

### Phase 2 — backup and restore alignment

- [x] Make backup inventory read installed manifests rather than current repo packages.
- [x] Include installed source metadata and package snapshots in the state archive/bundle inventory.
- [x] Hash every included snapshot payload as part of the broader backup-integrity work.
- [x] Validate snapshot/package compatibility before destructive restore begins.
- [x] Restore snapshots before reconciling app runtimes.
- [x] Define behavior when referenced upstream/base artifacts are unavailable.
- [x] Document that restoring the definition does not guarantee an upstream registry still serves an old artifact.

Acceptance:

- [x] Restore reproduces app settings/projections from the backed-up package snapshot even when the repo package has advanced.
- [x] Corrupt or missing snapshot payloads fail before services are stopped.

### Phase 3 — read-only official catalog refresh

- [x] Add the deterministic official `apps/catalog.json` projection.
- [x] Implement a source client with strict HTTPS/GitHub URL handling, timeouts, byte/file limits, redirects policy, and secret-free logs.
- [x] Resolve the configured branch to an immutable commit before downloading catalog/package content.
- [x] Cache last-known-good catalog data in bounded state with fetched time, revision, ETag where useful, and error status.
- [x] Refresh periodically with jitter/backoff and expose manual Refresh.
- [x] Keep install/manage UI functional from cache while offline.
- [x] Compare candidate package semver and digest against installed identity.
- [x] Represent same-version/different-digest as a catalog integrity error, not a silent update.
- [x] Add API fields for installed, available, update status, compatibility, and catalog freshness.
- [x] Add Apps UI update badges and read-only candidate details.

Acceptance:

- [x] A repo package bump appears as available without a MOS platform update.
- [x] Existing app UI remains shaped by installed data.
- [x] Moving branches cannot mix files from different commits.
- [x] Network or GitHub failure retains last-known-good behavior and never removes installed apps.

### Phase 4 — candidate comparison and preparation

- [x] Download candidates into isolated temporary directories and verify package digests before parsing executable/build inputs.
- [x] Validate minimum platform version and app-agent capability version.
- [x] Compare setup fields, secrets, services, volumes, routes, health, capabilities, integrations, resources, and privacy posture.
- [x] Define manifest update metadata for migrations, required owner actions, backup requirement, downtime, and rollback support.
- [x] Refuse undeclared breaking changes discovered by structural comparison.
- [x] Add a preparation API that never stops or mutates the installed app.
- [x] Show a plain-language update dialog with Advanced details for raw comparison/evidence.
- [x] Collect newly required non-secret/secret values before apply and keep them out of logs.

Acceptance:

- [x] Candidate preview is deterministic and has no runtime side effects.
- [x] Removed/renamed required fields or volumes cannot pass as a routine update.
- [x] Privacy regression and human-review status are visible before confirmation.

### Phase 5 — transactional per-app apply

- [x] Add app-agent update capability with explicit candidate snapshot path/digest and expected installed digest.
- [x] Reject stale apply requests when installed or candidate identity changed after preview.
- [x] Build candidate images before stopping current containers when resources permit.
- [x] Preserve volumes and integration state according to the declared migration.
- [x] Record update operation stages durably for restart recovery.
- [x] Health-check the candidate before committing snapshot/database identity.
- [x] Reconcile Caddy, Homepage, and cross-app networks as one reported transaction.
- [x] Retain one previous snapshot/image reference only where rollback is declared safe.
- [x] On failure, restore old containers/routes and leave an explicit recovery state when full rollback is impossible.
- [x] Remove the core updater's manual app-reapply warning only after installed apps are completely decoupled from repo-owned package files.

Acceptance:

- [x] Updating one app does not update the MOS platform or unrelated apps.
- [x] Success means running containers and persisted installed identity match the candidate.
- [x] Interruption at every durable stage recovers or reports an actionable state.
- [ ] A representative multi-service database app updates successfully on real hardware/VM validation.

### Phase 6 — advisories and version-aware privacy UI

- [x] Define a small official advisory index with affected package-version ranges, severity, type, evidence link, and remediation.
- [x] Validate advisory signatures/trust with the catalog source. (Trust is bound to the immutable official catalog revision the feed is fetched from, plus structural/unique-id validation; cryptographic signing remains Phase 8.)
- [x] Show installed assessment provenance and current advisory status separately.
- [x] Show candidate assessment and posture changes in update preview.
- [x] Allow a corrected assessment/advisory to update display metadata without pretending the installed runtime changed.
- [x] Add stale-review and changed-policy monitoring to the review workflow/CI.

Acceptance:

- [x] Owners on an older package see its installed review plus any current applicable advisory.
- [x] Owners do not see the newest package's rating presented as their installed rating.

### Phase 7 — external package sources

- [ ] Add an owner-only flow for a catalog/package URL with explicit risk explanation. (Contract/registry foundations landed; owner-facing API/UI flow is pending.)
- [x] Require HTTPS initially; define whether local/file sources are development-only. (`validateSourceUrl`/`buildSourceRecord`: uncredentialed HTTPS only; `local`/`file` sources are opt-in development-only.)
- [x] Store source URL, immutable revision, publisher identity/signature when present, and trust separately from package metadata. (New `app_sources` table plus registry record model; revision is bound separately via `withRevision` after resolution.)
- [ ] Enforce the constrained capability profile for non-official packages. (`validateConstrainedCapabilities` and the `validateExternalCandidate` gate exist and fail closed; still to be wired into a real external install path.)
- [ ] Display requested permissions before install and permission increases before update. (`describeRequestedPermissions`/`diffRequestedPermissions` primitives exist; UI display is pending.)
- [ ] Prevent external packages from claiming MOS review or using official identifiers/icons deceptively. (`validateExternalIdentity` blocks id/prefix/self-asserted-trust claims in the gate; install-path wiring and icon/UI labeling are pending.)
- [x] Namespace package/source identity to handle id collisions. (`namespacedPackageId`/`instanceNamespaceId`: official ids stay bare, other sources are isolated by a repository+path digest.)
- [x] Define source removal, ownership change, signing-key rotation, compromise, and unavailable-source behavior. (Registry status model with gated transitions: `unavailable`/`key-rotated` are recoverable and block new installs; `compromised`/`removed` are terminal.)
- [x] Provide Remove source without uninstalling already-installed snapshots. (`app_sources` has no cascade to `app_instances`; `removalPlan` marks matching installs source-orphaned while their snapshots stay installed and manageable.)

Acceptance:

- [ ] A valid unverified example installs through the same snapshot/app-agent pipeline with visible unverified status.
- [ ] Malicious path, host mount, privilege, raw proxy, and cross-secret fixtures fail before build/apply.
- [ ] Removing an external source does not break lifecycle management for its installed apps.

### Phase 8 — signing and operational hardening

- [ ] Choose and document catalog/package signing and key distribution/rotation.
- [ ] Verify signatures before granting `mos-reviewed` or `publisher-signed` trust.
- [ ] Add replay/downgrade protections while retaining an explicit advanced downgrade recovery path.
- [ ] Add bounded storage cleanup for candidates, previous snapshots, and unused images.
- [ ] Add catalog metrics/security events without URLs containing credentials or sensitive query data.
- [ ] Add rate limits and concurrency rules for refresh/download/build/apply.
- [ ] Add multi-architecture artifact validation.
- [ ] Exercise update, interruption, offline, restore, and compromised-source scenarios in human-run platform tests.

## Required test layers

- Unit: canonical hashing, safe extraction, semver/compatibility, trust derivation, structural diff, advisories, state transitions.
- Contract: manifest/catalog/source/privacy schemas and generic package fixtures.
- Store migration: old instances, clean installs, interrupted migrations, recovery states.
- Agent: snapshot path confinement, expected-digest checks, image labels, build context, rollback stages.
- HTTP: auth, refresh, candidate preview, stale confirmation, update progress, external-source permissions.
- Frontend: installed/candidate separation, offline cache, trust labels, privacy differences, breaking-change dialogs.
- Backup: snapshot inclusion, checksum rejection, restore against an advanced repository package.
- Human E2E: official catalog refresh and a single-service update first; then a representative multi-service/database update; external package validation only after the constrained model ships.

Do not run repository E2E automatically. Ask the user to run the relevant command and provide only the readiness summary or focused failure output.

## Security review checklist

- [ ] No source URL credentials appear in API output, logs, SQLite diagnostics, or Homepage.
- [ ] Downloads have time, redirect, byte, file-count, and decompression limits.
- [ ] Package extraction forbids absolute paths, traversal, symlinks, hard links, devices, and case-collision ambiguity.
- [ ] Package digests use canonical cross-platform input.
- [ ] Immutable revision is resolved before files are trusted.
- [ ] Official trust cannot be asserted by package-controlled fields.
- [ ] Candidate files cannot affect runtime before validation/confirmation.
- [ ] App agent accepts only host-owned validated snapshot roots and expected digests.
- [ ] External packages cannot acquire privileged capabilities through Dockerfile or manifest escape hatches.
- [ ] Update confirmation is bound to the exact previewed candidate digest.
- [ ] Failed updates cannot delete volumes or silently promote candidate identity.

## Compatibility and migration notes

- Existing `manifest.version` becomes explicitly the MOS app-package version; do not reinterpret it as the upstream version.
- Existing installations lack snapshots/source identity. Migration must compare stored `manifest_digest` and `package_version` with the current repo candidate before snapshotting it.
- Runtime build context changes from repository `apps/<id>` to a validated installed/candidate snapshot path. This is a host-agent API compatibility change and must be reconciled in the same managed platform update.
- Container/image labels should add package digest and source revision without changing persistent volume names.
- Stop remains non-destructive. Uninstall remains explicitly destructive.
- Backup format changes require versioning, checksum coverage, and pre-destructive restore validation.

## Open decisions to resolve during Phase 0

- Exact host snapshot root and which process owns each directory.
- Whether package downloads use GitHub tarballs, a repository content endpoint, or a provider-neutral archive convention first.
- Canonical package hashing implementation and treatment of documentation/assets.
- Whether the official catalog is committed, generated in CI, or served as a deterministic projection from manifests.
- Refresh interval and whether security advisories use a shorter interval.
- Initial maximum package/archive/build-context sizes.
- How update migrations are expressed without admitting arbitrary root scripts.
- Whether one previous locally built image is retained by label or explicit database reference.
- How source namespaces interact with current globally unique package ids.
- Signing technology and when it becomes mandatory for official updates.

## Completion gates

- [ ] Each installed app is operable from its snapshot with the repository unavailable.
- [ ] Official app updates are discoverable and applicable without a MOS platform release.
- [ ] Installed settings and privacy posture never silently switch to candidate metadata.
- [ ] Backup/restore preserves package identity and validates snapshot integrity.
- [ ] Update success implies all repo-owned runtime and metadata are on the candidate.
- [ ] External sources reuse the same pipeline with stricter, visible trust/capability handling.
- [ ] Documentation describes beta limitations, rollback boundaries, update trust, and external-package risk truthfully.
- [ ] This temporary plan is removed or replaced with concise shipped documentation and remaining GitHub Issue pointers.
