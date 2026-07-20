# Backup And Restore Reliability Plan

Status: active temporary epic plan. Use this checklist across agent sessions. Before merge, move unfinished work to GitHub Issues and remove or replace this file according to `docs/README.md`.

## Goal

Build a portable, app-independent recovery system that returns MOS authoritative persistent state to a backed-up point in time. Adding an app or feature must not require bespoke backup code.

Start with the smallest architecture that can make this guarantee. Scheduling, remote destinations, encryption UX, local snapshots, and broad compatibility are later hardening.

## Why This Became The Priority

The July 19, 2026 Hyper-V drill exposed a false restore:

1. The suite backed up a Stirling-only installation.
2. It installed Seafile and the remaining apps.
3. It restored the Stirling-only backup.
4. Suite Manager and Homepage showed Seafile as absent.
5. Seafile''s post-backup volumes remained.
6. Reinstalling Seafile generated new credentials but reused the old MySQL data, so authentication failed.

The control plane rolled back while persistent runtime state did not. Full restore must reconcile absence as well as presence.

## Owner Reasoning To Preserve

- Restore should return managed state to the recovery point, including removing later traces.
- Backup must live below rapidly changing features wherever practical.
- New apps should declare persistent state, not implement backup orchestration.
- System snapshots are attractive because they capture state without understanding apps.
- Home Assistant is a useful benchmark for restoring configuration, apps, and app data onto replacement hardware.
- Reliability and truthful status matter more than expanding the feature surface quickly.

## Minimal Architecture

### Authoritative persistent state

Back up only state that cannot be regenerated safely:

- Suite Manager''s authoritative database/state
- Secrets and owner configuration
- Installed package identities and package-owned configuration
- Every MOS-owned persistent app resource
- Other explicitly registered MOS-owned persistent files

Each persistent resource has a stable logical identity. MOS enumerates these resources generically without knowing app internals.

### Reinstallable software

The MOS release, host agents, package definitions, and containers are recreated from recorded compatible versions or immutable identities. Restore does not preserve running processes or RAM.

### Disposable runtime projections

Containers, networks, images, Compose output, routes, and Homepage entries are generated results. Restore removes stale projections and rebuilds them from authoritative state. Tests verify intended meaning and health, not Docker-generated identity equality.

### Optional local snapshots

VM or filesystem snapshots may later provide fast same-machine rollback. They do not replace portable recovery after disk loss or onto another machine.

## Core Contract

> After a successful full restore, MOS authoritative persistent state and installed-package state match the validated backup. No MOS-owned persistent resource created after that backup remains active or can be silently reused. Runtime projections are freshly reconstructed and verified.

Required invariants:

1. MOS can enumerate all persistent state it owns without an app allowlist.
2. Full restore reconciles presence and absence.
3. Non-MOS resources are never selected through guesses or broad name prefixes.
4. Backups are portable to a clean compatible MOS installation.
5. Stateful workloads are stopped or quiesced at the consistency boundary.
6. Bundle integrity, compatibility, paths, and required space are validated before mutation.
7. An interrupted restore cannot be reported as successful.
8. Restore preserves a recoverable previous state until the new state is verified.
9. A new app only declares persistent resources and a reproducible package identity.

## Deliberate Simplifications

- Do not back up or inventory ephemeral Docker objects as authoritative state.
- Start with a small ownership contract: managed marker, stable resource ID, and app instance ID.
- Do not support partial restore initially.
- First recreate the recorded compatible software, restore it, and upgrade afterward.
- Initially support a narrow, declared source/target version window.
- Require authenticated integrity first. Built-in encryption and recovery-key lifecycle follow after exact restore works; current unencrypted-bundle warnings remain.
- Preserve one rollback generation. Do not create simultaneous live, rescue, quarantine, and staging copies of every large volume.
- The first safe failure mode may require explicit operator rollback. Automatic rollback follows only after interruption behavior is proven.

## Storage-Generation Investigation

The preferred simplification to evaluate is versioned persistent-state generations with one active generation:

```text
/var/lib/mos/generations/
  current -> generation-42
  generation-41/
  generation-42/
```

A restore could build an inactive generation, recreate software against it, verify it, then activate it while retaining the previous generation for rollback.

This is not yet a decision. Before adopting it, prove:

- Docker can mount managed paths without manipulating Docker internals.
- Switching covers Suite Manager state, secrets, volumes, permissions, and services.
- Existing installations have a safe migration path.
- Disk requirements are bounded and visible before restore.
- Large files are not multiplied unnecessarily.
- Power loss around activation has deterministic recovery behavior.

If generations are unsuitable, choose the smallest alternative that preserves one untouched rollback copy and never restores over the only recoverable state.

Resolved 2026-07-19: generations were rejected (Docker named volumes cannot be re-pointed without bind-mount migration or touching Docker internals; a control-plane-only generation tree cannot make whole-state activation atomic). The adopted alternative — journaled restore, one complete rescue generation, absence reconciliation, verification-gated success — is recorded in `docs/decisions.md` ("Restore Uses A Journaled Rescue Generation, Not A Generation-Switched Store").

## Ordered Execution Checklist

Complete phases in order. Later product work must not block exact portable restore.

### Phase 1 — Define And Prove The State Model

- [x] Classify current data as authoritative persistent state, reproducible software, generated runtime, machine-local policy, or excluded state. — `managedStateTargets` in `infrastructure/persistent-state.cjs`; the backup engine stages exactly this list.
- [x] Define the minimal versioned persistent-resource ownership schema. — `mos.owned`/`mos.package`/`mos.instance`/`mos.resource` labels plus `appVolumeName`; applied at volume creation by the apps agent.
- [x] Define exact full-restore success, including absence and safe failure. — `BackupAgentCore.verifyRestore` compares restored instances and owned volumes against the manifest, presence and absence; failure leaves a journal, a rescue generation, and a blocked agent requiring acknowledgment.
- [x] Define the initial compatibility window and beta data-size limit. — restore accepts bundle schema versions 2-3; backups refuse above 256 GiB raw state (`RESTORE_COMPATIBLE_SCHEMA_VERSIONS`, `BACKUP_BETA_MAX_TOTAL_BYTES`).
- [x] Investigate generation storage against Docker, systemd, permissions, migration, disk use, and interruption behavior. — see resolution note above.
- [x] Record the generation decision in `docs/decisions.md` before implementation.
- [x] Add a regression that backs up Stirling-only state, installs Seafile, restores, reinstalls Seafile, and verifies database authentication and health. — simulation-level in `system-agents/backup/agent-core.test.cjs` (post-backup volumes cannot survive or be reused; reinstall gets a fresh labeled volume). Real database auth/health remains a Phase 4 Hyper-V drill.
- [x] Assert authoritative metadata, secrets, persistent resources, installed packages, regenerated routes/Homepage, and health—not UI state alone. — the regression asserts store contents, secret absence, volume contents/labels, reconciliation, and verification results.
- [x] Mark full restore experimental for exact rollback until Phase 4 passes. — `restoreGuarantee: 'experimental'` in `/backups/status` plus Backups UI copy.

Exit gate: the failure is reproducible, the state boundary is explicit, and the storage approach is supported by a technical proof.

### Phase 2 — Build Exact Portable Backup

- [x] Give each MOS-owned persistent resource a stable identity and authoritative ownership marker/registry entry. — ownership labels written at volume creation; restored volumes are relabeled from manifest identity.
- [x] Safely classify existing resources; report ambiguity instead of assuming ownership. — `classifyVolumes`: label first, per-package derivation second; prefix-only strangers are reported in the manifest (`ambiguousVolumes`) and job log, never claimed.
- [x] Implement one deterministic inventory of authoritative persistent state. — `managedStateTargets` plus classified volumes; the backup engine has no other source of coverage.
- [x] Stop or quiesce workloads and verify the consistency boundary. — app containers and Homepage stop; the Suite Manager database is captured as a `VACUUM INTO` point-in-time snapshot so the control plane can keep serving status.
- [x] Write a small versioned manifest with source version, installed packages, persistent-resource inventory, sizes, and authenticated digests. — schema version 3 with per-volume ownership evidence, raw sizes, and sha256 digests.
- [x] Stream archives in bounded memory. — tar subprocesses stream; hashing is chunked; archive readability checks discard listings instead of buffering them.
- [x] Reject unsafe paths, corrupt payloads, incompatible versions, and insufficient destination space. — destination/bundle path allowlists, digest checks, schema window, and two-stage space preflight (before stopping anything, and before the downloadable bundle copy).
- [x] Provide read-only bundle validation. — a `validate` job runs the full restore preflight (schema window, checksums, archive readability, package payloads) without mutating anything: agent `/v1/backups/validate`, Suite Manager `/backups/validate`, and a per-bundle "Check" button. It stays available while an interrupted restore blocks destructive work, and reports a recorded-vs-current MOS version mismatch as a warning.
- [x] Provide an owner-facing upload path for downloaded bundles. — added 2026-07-20 during the Phase 4 drills: a downloaded `bundle.tar.gz` is the complete bundle, so an `upload` job (agent `/v1/backups/upload` raw stream, Suite Manager `/backups/upload`, "Upload backup file" button) streams it onto a mounted destination, unpacks it, runs the full read-only validation, and writes the COMPLETE marker only on success — a failed or duplicate upload leaves nothing visible. Motivated by the replacement-machine drill: without it, recovery onto new hardware required shell access to copy bundles, which contradicts the plain-language operator story. Available while an interrupted restore blocks destructive work, since bringing a bundle in is part of recovery.

Exit gate: a generic backup captures current and synthetic future apps without app-specific backup code, and corruption fails validation.

### Phase 3 — Build Safe Replacement Restore

- [x] Validate the bundle and required live/rollback space before stopping workloads. — checksums, schema window, package payloads, and rescue/restore space checks all run before the first stop.
- [x] Persist a small journal with phase, active state, candidate state, and previous recoverable state. — atomic `restore-journal.json` advanced per phase; carries bundle path, job, and rescue location.
- [x] Preserve exactly one untouched rollback generation/copy. — complete rescue (control-plane state plus every owned volume), readability-checked; the previous generation is retired only after the new one is proven.
- [ ] Restore authoritative state and persistent resources into an inactive target. — restore is validated-then-in-place after the rescue copy; an inactive-target swap was rejected with the generation layout (see decision).
- [ ] Recreate the recorded compatible MOS/package software. — restore reuses currently installed MOS software with the bundle's validated package snapshots; recreating the recorded MOS version itself is not implemented. A recorded-vs-current version mismatch is now surfaced as a validation warning on both the read-only check and the restore job.
- [x] Regenerate containers, networks, configuration, routes, and Homepage. — reconciliation re-enables every installed instance from restored authoritative state.
- [x] Verify persistent inventory, installed packages, dependencies, routes, and health. — verification compares restored instances and owned volumes to the manifest; reconciliation enforces per-app health before it returns.
- [ ] Activate only after verification, or leave a clear recoverable failure requiring explicit rollback. — the second half holds (failure leaves journal, rescue, and a blocked agent); activation itself is in-place, so only the success report is verification-gated.
- [x] Detect interrupted restore on startup and never infer success. — an incomplete journal surfaces as `interruptedRestore` in agent status, blocks new jobs, and requires typed acknowledgment.
- [x] Retain previous state for a documented window with explicit cleanup. — the rescue generation persists until the next restore replaces it; acknowledgment records are kept under the agent state directory.

Exit gate: the Seafile regression passes, later persistent resources cannot be reused, and failure leaves an identified recoverable state.

### Phase 4 — Prove Recovery

- [x] Restore a representative multi-service backup on the original machine. — 2026-07-20 Hyper-V drill: three restore points (Stirling-only, Stirling+Seafile+Immich with data, +Radicale) restored in both directions; apps, users, files, and credentials intact; absence and presence reconciled each time.
- [ ] Restore it onto a clean compatible replacement VM using documented recovery material.
- [ ] Test corruption, wrong version, insufficient disk, disconnected destination, and interruption at major boundaries. — interruption tested 2026-07-20: hard power-off before validation completed behaves as if the restore never started; power-off during bundle validation left the suite intact but exposed a stale job bug: a job whose detached worker died pre-journal was reported as running forever and blocked new jobs. Fixed by reconciling the current job against the live worker process (`reconcileCurrentJob` in `system-agents/backup/agent.cjs`); needs a re-drill after a managed update. Corruption, wrong version, insufficient disk, and disconnected destination remain.
- [ ] Test a database-backed multi-service app and a large-data workload. — database-backed multi-service proven 2026-07-20 (Seafile/MySQL and Immich/Postgres restored with working logins and files); multi-GB large-data workload remains, including watching backup-agent memory against the bounded-streaming claim.
- [x] Confirm stale generated runtime is removed and regenerated. — verified on the VM 2026-07-20: after each restore only manifest-matching containers/volumes remained (`docker volume ls` showed exact owned-volume sets), Homepage tiles and routes regenerated.
- [x] Ask the owner to run the relevant Hyper-V E2E and provide the concise summary. — owner ran `npm run e2e:full` 2026-07-20 with backup/restore enabled; passed including restore verification assertions.
- [ ] Align UI and documentation claims with demonstrated behavior.

Exit gate: no tested path reports success without meeting the core contract, and same-machine and replacement-machine drills succeed.

### Phase 5 — Harden The Product Later

Prioritize these only after Phase 4 unless security review makes one a release blocker:

- [ ] Automatic rollback
- [ ] Built-in encryption and recovery-key lifecycle
- [ ] Scheduled and pre-update backups
- [ ] Retention and last-known-good protection
- [ ] Remote/object-storage destinations and resumable transfer
- [ ] Periodic verification restores
- [ ] One proven local VM/filesystem snapshot integration
- [ ] Wider version, hardware, or architecture compatibility
- [ ] Partial restore

Exit gate: each capability has a demonstrated need and does not weaken portable full restore.

## Session Handoff

1. Check an item only when code, tests, and evidence exist.
2. Record the next item and blockers in the active GitHub issue.
3. Keep the changelog release-shaped.
4. Update `docs/decisions.md` only when a durable contract changes.
5. Move unfinished tasks to GitHub Issues and remove this temporary plan before merge.
6. Do not run Hyper-V E2E automatically; ask the owner for the relevant summary.

## Definition Of Trustworthy

- Exact reconciliation of authoritative persistent state, including absence
- Complete bundle validation before mutation
- A recoverable previous state and deterministic interruption handling
- Reconstruction and health verification of disposable runtime
- Replacement-machine recovery
- Representative database and large-data workloads
- Truthful operator status
- No app-specific backup implementation for newly packaged apps

