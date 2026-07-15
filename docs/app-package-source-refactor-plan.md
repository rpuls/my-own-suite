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

- [x] Add an owner-only flow for a catalog/package URL with explicit risk explanation. (Backend orchestration landed in `ExternalSourceService` and is exposed over authenticated owner-only HTTP routes — `GET/POST /apps/sources`, `POST /apps/sources/{resolve,:id/status,:id/preview,:id/remove}`. Publishing convention: an external package is a `.mos/` folder at a repository root, so the owner pastes just the **repository URL** into the Apps search; `POST /apps/sources/resolve` parses it (host allowlist — GitHub only to begin with), resolves the commit, downloads a provider-neutral repo archive, extracts only `.mos/` through a hardened tar reader, runs the constrained gate, and returns an external/unverified app card — the package's own icon inlined, requested permissions listed, package id read from the manifest — persisting nothing until the owner installs. See [docs/decisions.md](./docs/decisions.md) (2026-07-15). The Apps screen now completes the owner flow: pasting a repo URL into the search box resolves it into an unverified external card, opening it shows the detail view with an explicit unverified-risk explanation and the plain-language requested-access list. Install now performs a real install: `POST /apps/sources/install` re-resolves and re-validates the URL, records the source, and installs the package, after which the owner lands on the normal app detail for the installed instance. From there the app is managed exactly like an official one, including updates: because MOS cannot learn an external repository's versions from cached catalog metadata, the detail view reports the source honestly and offers an explicit **Check for updates** that runs the ordinary update preview against the app's own recorded source.)
- [x] Require HTTPS initially; define whether local/file sources are development-only. (`validateSourceUrl`/`buildSourceRecord`: uncredentialed HTTPS only; `local`/`file` sources are opt-in development-only.)
- [x] Store source URL, immutable revision, publisher identity/signature when present, and trust separately from package metadata. (New `app_sources` table plus registry record model; revision is bound separately via `withRevision` after resolution.)
- [x] Enforce the constrained capability profile for non-official packages. (`ExternalSourceClient.downloadCandidate` runs every external candidate through the `validateExternalCandidate` gate and fails closed before any build/apply can consume it; the candidate cannot be produced unless the constrained profile passes.)
- [x] Display requested permissions before install and permission increases before update. (Before install: the external package detail view lists each requested route/volume/integration in plain language ahead of a real install, and `POST /apps/sources/:id/preview` returns the same set with trust for owner consent. Before update: `compareAppPackages` now carries `permissions.{installed,candidate,added,removed}`, and an increase becomes a change entry classified `operator-action-required` for any non-MOS-reviewed candidate — so it lifts `compatibility` to `owner-action-required` and the owner must accept it before the update applies. The update dialog renders the added permissions through the same `permissionLabel` plain-language mapping the install view uses. External updates run through the same `preparePackageUpdate`/`stagePackageUpdate` routes as official ones, because `downloadUpdateCandidate` picks the candidate source from the instance's recorded source rather than from the caller.)
- [x] Prevent external packages from claiming MOS review or using official identifiers/icons deceptively. (`validateExternalIdentity` blocks id-collision/reserved-prefix/self-asserted-trust in the download path before a candidate is returned, and the Apps UI reinforces this: the external card and detail view render the package's *own* inlined icon with an unmistakable "External · Unverified" badge, label trust as unverified and review as "Not reviewed by MOS", and never render any official/reviewed chrome or official-icon URL for a pasted package.)
- [x] Namespace package/source identity to handle id collisions. (`namespacedPackageId`/`instanceNamespaceId`: official ids stay bare, other sources are isolated by a repository+path digest. The namespaced id is now the installed identity end to end: it is the stored `app_instances.package_id`, the build context and loopback-port seed in `renderDryRunProjections`, and therefore the container/volume/network/route names the agent derives. `installedPackageFor` resolves it back to the manifest id, and the app agent independently refuses to snapshot an external candidate under a bare or mismatched id. See [docs/decisions.md](./decisions.md) (2026-07-15).)
- [x] Define source removal, ownership change, signing-key rotation, compromise, and unavailable-source behavior. (Registry status model with gated transitions: `unavailable`/`key-rotated` are recoverable and block new installs; `compromised`/`removed` are terminal.)
- [x] Provide Remove source without uninstalling already-installed snapshots. (`app_sources` has no cascade to `app_instances`; `removalPlan` marks matching installs source-orphaned while their snapshots stay installed and manageable.)

Acceptance:

- [x] A valid unverified example installs through the same snapshot/app-agent pipeline with visible unverified status. (`POST /apps/sources/install` → `ExternalSourceService.installUrl` re-resolves the commit, re-runs the constrained gate, records the source, then `AppPackageService.installExternalPackage` snapshots the candidate through the new `apps.package.snapshot.external` agent capability and persists config/projections/identity exactly like an official install; runtime apply and Homepage then run through the shared `performInstall` path. Unverified status stays visible after install: the instance stores `unverified` trust and `review-required` privacy, and the Apps list and detail render the "External · Unverified" badge plus an unverified notice. Covered by adapter, service, and HTTP tests; human E2E for external packages remains outstanding per Required test layers.)
- [x] Malicious path, host mount, privilege, raw proxy, and cross-secret fixtures fail before build/apply. (`external-source-client.test.cjs` proves impersonation, host-path/docker-socket mounts, privileged manifests, path traversal, and platform-incompatible candidates are all rejected by the download+gate path before any build/apply.)
- [x] Removing an external source does not break lifecycle management for its installed apps. (`ExternalSourceService.removeSource` is metadata-only: it marks the source removed, reports the source-orphaned instance ids, and never mutates any instance/projection/config row; `external-source-service.test.cjs` proves the orphaned install stays `installed` with its snapshot, projections, and config intact while unrelated official installs are untouched.)

### Phase 8 — signing and operational hardening

- [ ] Choose and document catalog/package signing and key distribution/rotation.
- [ ] Verify signatures before granting `mos-reviewed` or `publisher-signed` trust.
- [x] Add replay/downgrade protections while retaining an explicit advanced downgrade recovery path. (`stagePackageUpdate` refuses any candidate that is not strictly newer than the installed package: `installed-newer` is `APP_UPDATE_DOWNGRADE_BLOCKED`, `current` is `APP_UPDATE_NOT_AVAILABLE`, and same-version/different-digest was already `integrity-error` → unsupported. This is what stops a force-pushed, reverted, or taken-over source walking an app back to a version with published holes, because the source is re-resolved on every apply and nothing else would catch it. The recovery path is `allowDowngrade: true` on stage-update: it is deliberately not the same button that installs an update, and it still requires a `confirmationToken` bound to the exact installed/candidate digest pair, so consent to one reviewed downgrade never carries to a package the source swapped in afterwards.)
- [x] Add bounded storage cleanup for candidates, previous snapshots, and unused images. (Candidates: `candidate-storage.cjs` owns `stateDir/app-candidates`, the one place an unvalidated package may land. A killed Suite Manager used to leak its download there forever with no bound at all; the root is now swept before every download and once at startup, stale-first then oldest-first, and never touches a directory an in-flight operation in this process owns. Previous snapshots: `promoteAppPackageUpdate` retains exactly one `previous` per instance. Unused images: every image tag embeds the package digest, so each update used to leave its predecessor behind *tagged* — not dangling, so `docker image prune` never touched it — and growing by one generation per update forever. Promotion now reclaims them, under app-agent contract 8 and the `apps.package.update.reclaim` capability. The agent names the outgoing images from the manifest whose digest it just verified, so a caller cannot widen a reclamation by describing the old package as something it is not; the only new input is the outgoing source revision, which is not recoverable from a snapshot because it is deliberately not part of the digested package. A rollback-safe update keeps its predecessor's images and records their tags next to the retained snapshot, so the next promotion reclaims the generation it evicts rather than accumulating one per update; a rolled-back update reclaims the abandoned candidate's images, which a retry rebuilds from the same cached layers. Removal is `docker image rm` without `--force` with every failure ignored, so an image a container still references stays and reclamation can never break a running app or undo a committed update. `installedSourceRevision` is an optional promotion field gated on the capability: an older agent rejects unknown fields outright, and refusing a promotion after the candidate is already serving traffic would strand a committed update, so a version mismatch leaks an image instead. Still outstanding, and much smaller: uninstall does not reclaim its app's final image, which leaves one generation per uninstalled app rather than one per update.)
- [ ] Add catalog metrics/security events without URLs containing credentials or sensitive query data.
- [x] Add rate limits and concurrency rules for refresh/download/build/apply. (`app-operation-limits.cjs`, one limiter shared by the catalog service, the external client, and the package service — the bounds only mean anything shared. Refresh: pre-existing manual throttle plus single-flight. Download: 3 concurrent host-wide, 12 per source per minute, keyed per repository, generous enough that previewing an update and then applying it is never throttled. Build and the runtime swap: held under the app's key for the whole update transaction, because the store's durable "already running" guard only fires once the first update has reached the database — by then it has already downloaded and started building. Both bounds reject rather than queue, so a stuck source cannot stack the work the bound exists to prevent. Apply is deliberately left unserialized: it is local and idempotent, its expensive half is the build, and serializing it would turn concurrent Homepage/public-URL reconciles into reported per-app failures.)
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
