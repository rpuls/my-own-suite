# V2 Backup and Restore Design

Temporary branch research for `feat/app-platform-v2-lab`. Keep this concise; before merge, convert durable conclusions into `docs/decisions.md` and implementation follow-up into GitHub Issues.

## Research Summary

V1 backup/restore is a host-owned, whole-suite offline snapshot flow. Suite Manager talks to `mos-backup-agent` over a token-protected Unix socket, shows destinations, starts jobs, polls persistent job state, and keeps low-level logs behind advanced details. The agent discovers mounted or mountable storage under `/media`, `/mnt`, and `/run/media`, starts a worker, records a manifest, copies repo-managed runtime config, records rendered Compose config, stops the MOS Compose stack, archives Docker volumes, restarts the same detected profiles, and lists bundles from connected storage. Restore verifies manifest and archive checksums, creates a pre-restore runtime-config rescue archive, stops the current stack, restores config and Docker volumes, and restarts the profiles recorded in the bundle.

The V1 UX is directionally right: owners think in terms of "back up MOS" and "restore MOS", not per-container operations. Its limits are that the backup contract is hardcoded around V1 Compose profiles, known `mos_` volume names, and repo-managed `deploy/vps` config. V2 should reuse the concepts, not the shape.

V2 must protect Suite Manager SQLite, app instance/config/projection/operation state, app relationship state, app secret files, Homepage durable files, generated Caddy route state, non-secret HTTPS state, the Cloudflare DNS token file, app Docker volumes, package manifests/source version expectations, and enough runtime metadata to recreate containers and routes. V2 adds package instances, capability relationships, companion apps, generated secret references, tokenized helper routes, and package-owned multi-service networks. Those are not just "more volumes"; they are restore ordering and compatibility constraints.

The recommendation is to keep one whole-suite backup as the primary UX. Per-app backup should be hidden or future-only until the whole-suite model is trustworthy.

## Product Goal

The default user promise should be: "Back up everything needed to recover this MOS install." A normal owner should see one Backup page, one primary "Back up everything" action, recent backup history, and a clear Restore entry point.

Advanced details should remain available for support: manifest contents, protected paths, app volume names, package versions, checksums, logs, and restore plan diagnostics. They should not be front-and-center.

## V1 Findings

V1 strengths:

- Friendly Backup and Restore screens instead of command-line-only recovery.
- Capability-gated behavior when the host backup agent is missing.
- Destination discovery that separates mounted storage, mountable drives, unsupported/system devices, free space, and writable state.
- Persistent job files so Suite Manager restarts do not lose progress.
- Cold volume snapshots by stopping the stack during archive.
- Backup bundles with `manifest.json`, `MANIFEST.sha256`, `mos-config.tar.gz`, readable config copy, rendered Compose config, volume archives, and restore notes.
- Restore preflight verifies checksums and tar readability before downtime.
- Restore creates a pre-restore rescue copy of current runtime config.
- Logs are summarized in the UI and tucked behind Advanced details.

V1 assumptions to avoid in V2:

- Hardcoded Compose profiles and expected volume names.
- Treating `deploy/vps` runtime config as the canonical full suite state.
- Restoring only `mos_` volumes, which does not fit V2 `mos-v2-app-*` volume naming or control-plane state paths.
- No package-level distinction between durable data, cache, generated runtime state, or dump-preferred databases.
- Version pairing is conservative but too coarse for V2 package restore compatibility.

## V2 Data Inventory

Canonical backup data:

- Suite Manager SQLite: `suite-manager.sqlite` under `MOS_V2_STATE_DIR`, including owner/session state, HTTPS non-secret state, Homepage operation revisions, app instances, app config references, app projections, app operations, setup-guide state, and app integration relationships.
- SQLite WAL/SHM state if backed up live; prefer cold backup or SQLite backup API.
- App raw secrets under Suite Manager state `app-secrets/<instance-id>/*.secret`.
- HTTPS agent secret file `/etc/mos-v2/secrets/caddy-cloudflare.env`.
- Homepage durable config under `MOS_V2_STATE_ROOT/homepage/config`, especially `services.template.yaml`, `bookmarks.yaml`, `settings.yaml`, `widgets.yaml`, `custom.css`, `custom.js`, and `images/`.
- App Docker volumes named by the V2 app agent as `mos-v2-app-<package-id>-<declared-volume>`.
- App integration state in SQLite plus any consumer projection changes produced by relationships, such as Seafile consuming ONLYOFFICE JWT material through an allowlisted service-env target.
- Source checkout identity: repo URL/ref/commit, package manifest digests, package versions, Dockerfiles, entrypoints, and runtime renderer versions.

Regenerable or secondary data:

- `/etc/caddy/mos-v2-homepage-routes.caddy` and `/etc/caddy/mos-v2-app-routes.caddy` are generated route projections, but backing them up is useful for audit and recovery diagnostics.
- Main Caddyfile is generated from HTTPS state plus bootstrap state, but the active file should be included as diagnostic/restoration input.
- Homepage `services.yaml` is generated from `services.template.yaml`.
- App containers, package networks, built images, Caddy validation candidates, agent checkpoints, and operation logs can be regenerated or discarded.
- Cache volumes should be excluded only when a package contract explicitly marks them cache/regenerable.

Current packages:

- `stirling-pdf`: one public service; durable volumes `training-data`, `configs`, `custom-files`, `logs`, `pipeline`.
- `vaultwarden`: one public service; durable `data`; generated `adminToken` secret.
- `radicale`: one public service; durable `data`; user `adminPassword` secret and generated `icalToken` secret; tokenized iCal helper route.
- `seafile`: multi-service package; durable `mysql-data` and `data`; generated MySQL/JWT secrets; internal Valkey with no declared persistent volume; exports `document-platform` and imports document-editor providers through service-env config.
- `onlyoffice`: one public capability-provider service; durable `data`; generated JWT and secure-link secrets; exports `document-editor`; usually has no Homepage shortcut.

## Backup Model Recommendation

Whole-suite backup should be the primary and initially only owner-facing model. Per-app backup should remain future advanced work, mostly useful for export/import or migration, after whole-suite restore is proven.

Use cold backups by default for the first implementation. Stop Suite Manager, Homepage, and all V2 app containers through host-owned agents or systemd/Docker discovery, then archive canonical state and volumes. A later package contract may allow app-specific online dumps, but cold backup is simpler, safer, and easier to explain.

The backup should include:

- Suite Manager state directory, including SQLite and app secrets.
- V2 state root Homepage config.
- `/etc/mos-v2/secrets` entries required by MOS-owned agents.
- Caddy MOS-owned active/generated files for audit and fallback.
- All package-declared durable Docker volumes for installed or preserved-data apps.
- Package manifests, manifest digests, package versions, repo commit/ref, runtime service/unit metadata, and active relationship state.
- A machine-readable backup manifest plus human-readable restore notes.

The backup should exclude:

- Running containers and images.
- Generated `services.yaml` as canonical data, though it can be included diagnostically.
- Temporary agent checkpoints, candidate files, operation scratch dirs, and health probe output.
- Cache/runtime volumes only after manifests support an explicit `backup.class: cache` or equivalent.

## Package Contract Implications

V2 manifests need backup metadata rather than agent-side guesses. Suggested future shape:

- `backup.volumes[]`: declared volume name, class (`data`, `database`, `cache`, `generated`), required-on-restore, and optional description.
- `backup.databases[]`: service, engine, volume, and future dump preference. First slice can still cold-archive the volume.
- `backup.quiesce`: safe stop/start order or service groups when package default order is insufficient.
- `backup.restore`: restore order, required secrets, whether existing preserved-data volumes must be overwritten, and package version compatibility policy.
- `backup.externalDependencies`: object storage, remote SMTP, DNS, identity providers, or other state MOS cannot fully capture.
- `backup.integrations`: whether relationship state is purely SQLite/projection data or needs package-specific post-restore validation.

Until that contract exists, the V2 inventory endpoint can infer declared volumes from `resources.services.*.volumes`, but it should report the result as "discovered from current manifest" rather than "package backup contract satisfied."

## Backup Agent Boundary

V2 should keep backup/restore host-owned. Suite Manager must not gain broad Docker, filesystem, mount, or systemd privileges.

A new `mos-v2-backup-agent` should own:

- destination discovery and mount operations;
- backup inventory/dry-run;
- quiesce/freeze/stop and restart coordination;
- archive creation, checksums, and manifest writing;
- restore planning, validation, destructive apply, and rescue snapshot creation;
- sanitized persistent job state.

The API should be structured and capability-gated, like the existing V2 agents. It should not accept arbitrary shell, paths outside allowlisted destinations/state roots, raw Docker commands, or raw Caddy text. Logs should use fixed messages and redacted identifiers where possible.

## UX Recommendation

Backup page:

- Header status: backup agent available/unavailable, last successful backup, current risk note.
- Destination selection: connected storage, mount action, free-space estimate, writable state.
- Primary action: "Back up everything".
- Inventory preview: "This backup includes Suite Manager, Homepage, HTTPS settings, installed apps, app relationships, secrets, and app data." Put exact paths/volumes behind Advanced details.
- Progress: queued, checking space, stopping apps, saving suite state, archiving app data, writing manifest, restarting, completed/failed.
- Recent backups: date, MOS version/commit, app count, volume count, archive size, destination.
- Restore entry point: available backups plus "Restore..." action.

Restore page/dialog:

- Choose backup from detected bundles or scan storage.
- Inspect manifest: source MOS version/commit, package list, relationship list, created date, contents summary.
- Show compatibility warnings before confirmation.
- Create a pre-restore safety snapshot automatically.
- Require destructive confirmation for existing installs.
- Show progress: verifying backup, saving rescue snapshot, stopping current runtime, restoring state, restoring volumes, reconciling agents, starting control plane, reapplying packages/relationships, health checks.
- Keep raw manifest/checksum/log details under Advanced details.

## Restore Safety

Restore must be conservative:

- Verify manifest schema, manifest checksum, archive checksums, tar readability, and path containment before downtime.
- Support fresh install restore first. Existing-install restore requires explicit confirmation and a pre-restore rescue backup.
- Check repo commit/ref and V2 runtime compatibility. If exact commit is unavailable, require a manifest-declared compatible range.
- Check that each package exists locally and its manifest digest/version is compatible with the backup.
- Detect existing V2 app volumes before overwrite and require destructive confirmation.
- Restore raw app secrets and HTTPS DNS token with strict ownership and modes before runtime reapply.
- Restore Caddy/HTTPS state carefully: keep bootstrap HTTP recovery host available, regenerate active config from restored non-secret state plus restored token, then validate Caddy.
- Restore integration relationships after provider and consumer instances and secrets are present. Reapply/revalidate relationships rather than assuming restored projections are healthy.
- If restore fails after downtime, restart either the pre-restore runtime or the partially restored runtime with clear recovery status; do not report success until Suite Manager and package health checks are truthful.

## First Implementation Slice

Build a V2 backup inventory/dry-run slice first.

Recommended scope:

- Add a V2 backup-agent status/inventory API that reads only current state and reports what would be protected.
- Include Suite Manager DB path, app secret directory, Homepage config path, HTTPS secret path presence, generated Caddy files, installed package list, package manifest digests, declared volumes, relationship count/status, and estimated backup classes.
- Add manifest validation warnings for packages that declare volumes but no explicit backup metadata.
- Add a Backup page skeleton that shows "Back up everything" as the product model, but disables actual backup until inventory is green.

Do not implement full archive/restore first. Do not start with per-app backup, cloud destinations, online database dumps, or destructive restore. Those are later layers once inventory and package contract validation are trustworthy.

## Testing and Validation Strategy

- Unit tests for package backup metadata validation once the manifest contract exists.
- Unit tests for inventory path allowlisting, secret redaction, volume classification, and generated-state exclusion.
- Local dry-run using fixture state and fake Docker volume inspection.
- Agent API tests for unauthorized requests, path traversal, unsupported destinations, and sanitized errors.
- Hyper-V full backup/restore validation before trusting the UX: install apps, customize Homepage, enable HTTPS, connect Seafile and ONLYOFFICE, create app data, back up, restore onto a fresh V2 install, and verify app health plus relationship recovery.
- DigitalOcean smoke should remain user-triggered; use it later for install-path compatibility, not early design proof.
- Tamper tests: missing secret file, missing package, manifest digest mismatch, corrupt archive, existing volume conflict, invalid Caddy config, disabled provider relationship.
- Restore verification should check Suite Manager login, Homepage dashboard, app routes, app health, secret-dependent startup, HTTPS recovery URL, and relationship status.

## Open Questions

- Should the first real backup archive stop only V2 app containers or also stop Suite Manager and Homepage? Recommendation: stop all MOS-owned runtime for the first full backup; use an agent-side job store so progress survives UI downtime.
- Should Cloudflare DNS token be included by default? Recommendation: yes for whole-suite recovery, with clear encryption-at-rest or owner-warning requirements before shipping broadly.
- Should app caches be backed up by default? Recommendation: yes until packages can explicitly mark cache/regenerable volumes; correctness beats space savings initially.
- How should backups be encrypted? Recommendation: not optional for broadly shipped owner backups that contain secrets; design key/passphrase UX before exposing production backups.
- Can V1 bundles restore into V2? Recommendation: no automatic restore. Treat V1-to-V2 as a separate migration/import design.
- How are preserved-data uninstalled apps represented? Recommendation: include their Suite Manager state, secrets, and volumes until the user explicitly deletes abandoned data.

## Final Recommendation

MOS V2 should keep and improve the "one backup for everything" UX. Under the hood, V2 needs a package-aware whole-suite manifest and a narrow host-owned backup agent that understands Suite Manager SQLite, app secrets, Homepage durable files, HTTPS/Caddy state, app volumes, and capability relationships. The smallest safe next step is an inventory/dry-run endpoint and Backup page preview, not a full restore engine.
