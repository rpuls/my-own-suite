# Changelog

Notable updater-facing software changes are documented here. Documentation, public-site, landing-page, repository-maintenance, contributor-workflow-only, and minor cosmetic changes are intentionally excluded.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

## [0.15.0] - 2026-07-25

### Added

- My Own Suite is now officially licensed as free and open-source software under the GNU Affero General Public License v3.0 only.

## [0.14.0] - 2026-07-24

### Added

- Every official catalog app now carries a published MOS privacy assessment. Immich, ONLYOFFICE, Vaultwarden, and Seafile are graded B ("Privacy configured"), while Radicale is graded A ("Private by default"). Their package versions were bumped so existing installations receive the assessments through ordinary app updates.

### Changed

- Suite Manager's app detail view now puts status, screenshots, privacy posture, resources, connections, and owner-relevant information first, with low-level diagnostics kept under Advanced details. App packages can now ship screenshots through the authenticated package API.
- Cloud owner setup now asks for the one-time claim key before account details when a setup link is incomplete, accepts the full printed key line, and allows a mis-copied key to be replaced. Owner setup also requires password confirmation.
- Privacy posture is presented as an A-to-D grade instead of a 0–10 score throughout Suite Manager and update review.
- The installer now prints one correct finish-setup link: cloud installs show only the claim-key URL required to create the owner account.
- Optional catalog and advisory refreshes now run quietly in the background. The Apps screen uses the signed catalog bundled with the release and no longer interrupts owners when a network refresh is stale or unavailable.
- Suite Manager's first-run screen now guides owners through installing an app, adding it to Homepage, and creating a backup. App connections use a clearer visual with a direct Connect action.
- App update availability is now determined by package version and MOS compatibility. Package contents must change version, downloaded updates remain verified against the signed catalog digest, privacy-assessment metadata no longer blocks official updates, and incompatible updates are explained in app details without an actionable badge.

### Fixed

- Catalog refresh now accepts a valid `304 Not Modified` response while continuing to reject actual redirects.
- Newly installed apps no longer show false catalog-integrity conflicts when the local checkout and catalog branch are at different commits.

### Compatibility

- Catalog package versions are Immich 0.4.0, ONLYOFFICE 0.2.0, Radicale 0.3.0, and Seafile, Stirling PDF, and Vaultwarden 0.2.1. Radicale also updates to 3.7.6.

## [0.13.0] - 2026-07-21

### Changed

- The Stable update track can now apply tagged releases. Fresh installs default to Stable, named-branch checkouts continue following their branch, and branch-track updates land exactly on the tracked remote branch even after rewritten history.

## [0.12.0] - 2026-07-21

Milestone release: My Own Suite is now an app platform instead of a fixed suite, with versioned and signed app packages managed individually through Suite Manager.

### Added

- Added browser owner setup, an authenticated Home/Suite Manager control plane, manifest-driven app lifecycle management, Homepage customization, private-LAN and public-VPS HTTPS, whole-suite backup and restore, and managed platform updates.
- Added independently versioned app packages with validated snapshots, preview, build, health-check, activation, rollback, recovery, and lifecycle handling. External Git packages use the same constrained pipeline and remain visibly **External · Unverified**.
- Added MOS Privacy Posture with evidence, provenance, freshness, per-dimension findings, and an explicit unrated state.
- Added hosted stable and development installers, a zero-configuration USB installer, and cloud and local installation paths.
- Added packages for Stirling PDF, Vaultwarden, Radicale, Seafile, ONLYOFFICE, and Immich, including setup fields, secrets, multi-service runtimes, Homepage projections, and Seafile/ONLYOFFICE integration.

### Changed

- App installs and updates retain the exact validated package snapshot. Update review shows permissions, privacy changes, migrations, downtime, backup requirements, and breaking changes before applying the reviewed digest.
- Uninstall confirmation now clearly distinguishes permanent removal of app resources and data from stopping an app while retaining its data.
- Whole-suite backup and restore now use schema version 3 with owned-resource inventory, database-consistent snapshots, size accounting, preflight bundle checks, uploaded-bundle validation, operator notes, and interruption recovery. Restore reconciles resources created after the backup, preserves one rescue generation, verifies the restored inventory, checks disk space, and refuses ambiguous or unsafe destinations. Version 2 bundles remain restorable.
- Managed platform reconciliation refreshes Suite Manager, Caddy wiring, Homepage, systemd units, and repo-owned host agents without rebuilding installed apps. Main and Staging branch tracks are selectable; installed apps continue updating separately from their retained package snapshots.

### Fixed

- Hardened app update interruption and rollback recovery, integrated-app updates, disabled and concurrent lifecycle handling, external app identity and configuration, orphan reporting, privacy-review validation, bounded backup hashing, image cleanup, and runtime status reporting.
- Public-cloud owner setup now uses trusted HTTPS, a root-only one-time claim secret, secure cookies, and firewall configuration.
- Fixed DNS-01 and Homepage route reconciliation so MOS-owned links follow the active domain without rewriting user-authored links, and managed updates retain installed Home and state paths.

### Security

- Official catalog and advisory files now require offline Ed25519 verification against the key shipped with the release; invalid or missing signatures fail closed.
- External packages are rejected before build or apply when they request unsafe privileges or undeclared capabilities. Downloads use immutable revisions with bounded time, redirects, size, file count, extraction, canonical paths, and concurrency.
- Added bounded progressive login throttling by client and account, trusted-proxy handling, `Retry-After`, and secret-free security aggregates with retention limits.

### Compatibility

- Removed the temporary generation label from MOS-owned environment variables, runtime paths, services, sockets, containers, and backup folders. Prototype environments should be reset before validation.
- MOS paths now live at the repository root, and the control-plane URL moved from `suite-manager.<domain>/setup/` to `home.<domain>/suite-manager/`.
- The app-agent contract is version 9. Manifests may constrain `amd64` and `arm64`; backup schema 2 rejects pre-snapshot bundles; external routes use `ext-<host>`; and releases require matching signed catalog and advisory metadata.
- USB installer owner fields were removed. Owners are created in the browser, and each installer build generates a unique machine login password.

### Known limitations

- MOS is beta. Platform updates leave installed apps on their package snapshots; apps update separately.
- Backups are manual, whole-suite, unencrypted, destination-limited, and version-sensitive. Restore requires a compatible MOS installation, and rollback is not guaranteed across data migrations.
- External packages remain unverified; publisher-key verification and cryptographic replay prevention are not yet implemented.

## [0.11.0] - 2026-06-07

### Changed

- Added repo-owned self-host service and backup agents. Managed reconciliation now maintains their systemd units, sockets, tokens, and Suite Manager mounts, while compatibility wrappers preserve the former update-agent paths.
- Added offline whole-suite backup and restore with mounted local, removable, and network destination discovery, capacity and free-space checks, cold volume archives, bundle validation, rescue copies, persistent job state, and capability-driven Suite Manager controls.
- Update and backup actions are now capability-driven: managed controls appear only when their corresponding host agent advertises support.
- Homepage customization can validate and apply generated external Caddy proxy routes through the service agent or `npm run caddy:external-proxies:apply`, while explicit user-authored links remain untouched.
- Added Cloudflare DNS-01 HTTPS configuration through Suite Manager, using a shared `DOMAIN`, `PUBLIC_URL_SCHEME`, and `MOS_TLS_MODE` contract for Caddy routes and managed Homepage links.

### Compatibility

- Self-host reconciliation manages `mos-update-agent`, `mos-service-agent`, and `mos-backup-agent`, their `/run` sockets, `/etc` token files, and Suite Manager env/socket mounts.
- `SUITE_MANAGER_UPDATES_MODE` was removed from active configuration.
- Caddy now imports generated snippets from `deploy/vps/generated/caddy/*.caddy`; DNS-01 mode also uses `deploy/vps/services/caddy/.env` and requires HTTPS, a real domain, an ACME email, and a Cloudflare API token.

### Fixed

- Managed updates can recover when the only dirty file is the generated external-proxy Caddy snippet.
- Fixed onboarding clipboard feedback and hardened Vaultwarden onboarding against upstream UI changes.

## [0.10.0] - 2026-05-29

### Changed

- Updated application images and dependencies, including Seafile 13 and its native database, admin, and cache bootstrap settings.
- Replaced Seafile's Memcached service with Valkey and added a migration for existing installations.
- Improved self-host installer handoff so domain, Linux, and Suite Manager settings flow through one first-boot manifest, supported Ubuntu media can be fetched automatically, and installation remains human-confirmed.
- Added managed self-host updates through `mos-update-agent`, including update-track selection, job status, full profiled image rebuilds, container recreation, and obsolete-service cleanup without removing persistent volumes.
- Added named own-infrastructure migrations for compatibility changes during managed updates.
- Moved Homepage customization into Suite Manager-owned runtime config with allow-listed YAML, CSS, and JavaScript editing and validation.

### Compatibility

- The Seafile cache service is now `seafile-valkey`; cache configuration uses `CACHE_PROVIDER=redis` and `REDIS_*` variables instead of `MEMCACHED_*`.
- Self-host setup recognizes `UPDATE_TRACK` and `UPDATE_REF`, and managed installs use `SUITE_MANAGER_UPDATES_MODE=managed`.
- Homepage runtime config uses `HOMEPAGE_CONFIG_SYNC_TOKEN`; `services.yaml` remains generated from `services.template.yaml`.

### Fixed

- Fixed Vaultwarden startup when shared SMTP is disabled, Suite Manager startup with default Homepage runtime state, self-host owner and domain propagation, ONLYOFFICE startup with newer images, and PostgreSQL 18 volume layout for Vaultwarden.

## [0.9.0] - 2026-04-17

### Changed

- Hardened the single-USB installer so it requires explicit confirmation, carries the primary user into bootstrap, and starts the stack after setup.
- Added deployment-aware update status in Suite Manager, release metadata checks, and manual self-host/VPS update commands with preflight safeguards.
- Reworked onboarding into dependency-based tracks after Vaultwarden credential setup.
- Added optional shared SMTP configuration consumed by Seafile and Vaultwarden.

## [0.8.0] - 2026-04-10

Milestone release: MOS gained a validated self-host installation path on home-server hardware over LAN.

### Changed

- Added an Ubuntu 24.04 single-USB installer builder with a clearly destructive boot entry and a ready-to-flash output image.
- Hardened the default stack against third-party calls by removing remotely hosted fonts and Homepage icons, disabling Vaultwarden relay push, and disabling Stirling PDF analytics by default.
- Fixed Vaultwarden credential-import onboarding and a Suite Manager runtime syntax error.

## [0.7.0] - 2026-03-29

### Added

- Added the Ubuntu 24.04 self-host bootstrap path, canonical `appname.mos.home` and `appname.mos.<your-domain>` addressing, Cloudflare wildcard tunnel scaffolding, and unattended installation support.

### Changed

- Hardened the default stack against third-party calls by removing remotely hosted fonts and Homepage icons, disabling Vaultwarden relay push, and disabling Stirling PDF analytics by default.

### Fixed

- Fixed Vaultwarden credential-import onboarding so the flow advances after manual confirmation.

## [0.5.0] - 2026-03-24

### Changed

- Improved first-run credential handoff from Suite Manager to Vaultwarden.
- Changed the default Docker Compose project name to `mos`; generated networks and named volumes now use the `mos_` prefix instead of `vps_`.
- Hardened local cross-platform operation with simpler `*.localhost` routing and Windows-safe script and entrypoint line endings.

## [0.4.0] - 2026-03-18

### Added

- Added the authenticated Suite Manager control plane with persistent onboarding state and guided first-run setup.

### Changed

- Made Suite Manager the single control-plane entry point, with Homepage linking into `/setup/`.
- Improved onboarding with Vaultwarden-first setup, guided Radicale connection, clearer completion, and a direct return to Homepage.
- Replaced the bootstrap-token gate with owner email/password authentication and signed sessions. `BOOTSTRAP_TOKEN` was replaced by required `OWNER_PASSWORD` and `SESSION_SECRET`; `SUITE_MANAGER_URL` now requires the `/setup/` suffix.
- Removed `HOMEPAGE_PUBLIC_URL` from the Suite Manager contract in favor of `HOMEPAGE_URL`.
- Added shared owner and integration inputs for Suite Manager and changed local/VPS Vaultwarden routing to HTTPS.

## [0.3.0] - 2026-03-09

### Added

- Added the initial Suite Manager service with status reporting and Homepage health checks.

### Changed

- Reworked VPS/local setup around shared Suite Manager inputs and service-level env templates.
- Simplified `vps:init` and `vps:doctor` for the new template layout and removed legacy `.env.example` compatibility.
- Fixed `vps:rebuild` so clean-slate rebuilds remove profiled service volumes and auth state.

## [0.2.0] - 2026-03-08

### Added

- Added `vps:init`, `vps:doctor`, and `vps:up` for non-destructive VPS configuration and startup.
- Added generated and shared secret expressions plus derived Base64 values in env templates.

## [0.1.0] - 2026-03-04

First official release of My Own Suite, establishing the release foundation and initial Docker Compose application stack.
