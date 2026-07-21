# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [0.13.0] - 2026-07-21

### Changed

- The Stable update track can now apply tagged releases: the update agent fetches and checks out the published release tag, compares the installed version against the newest release, and the Updates screen lets owners select and apply Stable. Fresh installs now default to the Stable releases track, while checkouts sitting on a named branch keep following that branch. Branch-track updates now land exactly on the tracked remote branch even if its history was rewritten, instead of failing the fast-forward pull.

### Fixed

- Aligned the Updates screen track-switch button with the track dropdown instead of its label.

## [0.12.0] - 2026-07-21

Milestone release: My Own Suite is now an app platform instead of a fixed suite. This release replaces the pre-assembled app bundle with the MOS app-store architecture — versioned, signed app packages installed and managed individually through Suite Manager — and makes the rebuilt MOS layout, public site, and hosted installer the default for every new install.

### Added

- Made MOS the default repository layout, with browser owner setup, an authenticated Home/Suite Manager control plane, manifest-driven app installation and lifecycle management, Homepage customization, private-LAN and public-VPS HTTPS paths, manual whole-suite backup/restore, and early managed platform updates.
- Added independently versioned, source-addressed app packages. Official and constrained external Git sources use the same snapshot, preview, build, health-check, activation, rollback/recovery, and lifecycle pipeline; external packages remain visibly **External · Unverified**.
- Added MOS Privacy Posture to Suite Manager and the public catalog, with evidence, provenance, freshness, per-dimension findings, and an explicit unrated state. Stirling PDF is the first and currently only assessed package; all other apps say **Not yet rated by MOS**.
- Added hosted stable and development installer endpoints, a zero-configuration USB installer, DigitalOcean and generic Ubuntu VPS installation, and disposable Hyper-V/DigitalOcean validation harnesses built from the shared installer contract.
- Added app packages for Stirling PDF, Vaultwarden, Radicale, Seafile, ONLYOFFICE, and Immich, including generic setup fields, secrets, multi-service runtimes, onboarding guides, Homepage projections, and the Seafile/ONLYOFFICE capability integration.

### Changed

- App installs and updates now retain exact validated package snapshots so installed metadata, configuration, privacy posture, routes, integrations, backups, and lifecycle operations do not silently follow a moving repository. Update review shows permissions, privacy, migrations, downtime, backup requirements, and breaking changes before applying the reviewed digest.
- Public documentation and landing copy now scope privacy claims to MOS-controlled behavior, distinguish assessed, unrated, and external packages, document outbound dependencies, and describe the cloud-provider trust boundary. Docs also state that pre-1.0 MOS is intended for evaluation and non-critical use with independent backups, describe the shipped one-line cloud installer accurately, and set Immich backup-size expectations alongside its resource requirements.
- Uninstalling an app now asks for confirmation at the action point, spelling out that containers, web address, Homepage shortcut, settings, secrets, and data volumes are deleted, while Stop is labeled as keeping data.
- Backup documentation and Suite Manager now distinguish own-hardware external drives from cloud-server block-storage volumes. Backup bundles are described at creation and download as unencrypted full-secret exports requiring encrypted, access-controlled storage; direct object-storage destinations are not supported. Recovery architecture now requires portable, app-agnostic authoritative-state backups, reconciliation of later persistent resources, a preserved recoverable state, regenerated runtime projections, and separately scoped optional local snapshots.
- Full restore now reconciles absence as well as presence: app volumes created after a backup are rescued and removed instead of silently surviving to be reused by a later reinstall. MOS-owned volumes are created with ownership labels and never selected by name prefix alone; ambiguous volumes are reported and left untouched. Restores keep one complete rescue generation (control-plane state plus all owned volumes), run under a durable journal that surfaces interrupted restores and blocks new backup/restore work until acknowledged, verify the restored inventory against the bundle before reporting success, and check destination and rollback disk space before mutating anything. Backup bundles move to schema version 3 (owned-resource inventory, consistent database snapshot, size accounting); version 2 bundles remain restorable. A read-only bundle check runs the full restore preflight without touching the running suite — available from the Backups screen per bundle, even while an interrupted restore blocks destructive work — and warns when a bundle was created by a different MOS version. A previously downloaded backup file can be uploaded back to a mounted destination from the Backups screen — including onto a fresh replacement install — and becomes restorable only after passing that same validation. The backup list shows each bundle's size, collapses past three entries, moves per-bundle actions into a compact menu, supports deleting bundles behind a confirmation (refused while a job runs or an interrupted restore is unacknowledged), and each backup can carry an operator note describing the restore point, stored beside the bundle on its drive. Reinstalling an app over persistent data left by a different installation now fails clearly instead of pairing fresh credentials with old data. Full restore completed the recovery drills — same-machine and replacement-machine restores, database-backed and multi-gigabyte workloads, corruption/version/disk/disconnected-destination refusals, and mid-restore power-loss recovery — and is no longer labeled experimental. Because a restore replaces Suite Manager state, it also ends the operator's session; the Backups screen now says so and routes back to sign-in with the backup's owner account instead of showing an endless progress spinner. During a running restore the screen sets expectations that large backups take time and the suite may look offline, and warns before the operator leaves or refreshes the page. A backup, check, or restore whose worker process died without finishing (for example a power loss before any change was made) is now reported as failed and stops blocking new jobs, instead of being shown as running forever. Backups and uploads now refuse a destination whose drive is no longer mounted, a backup whose drive disappears mid-job is reported as failed instead of silently writing to the system disk and claiming success, and a failed backup's partial bundle is removed instead of lingering on disk.
- Managed reconciliation refreshes Suite Manager, Caddy wiring, Homepage, systemd units, and repo-owned host agents without terminating the active updater. Branch-track updates can follow the Main branch (the default for fresh installs) or the Staging branch, selectable from the Updates screen. The Stable release track is visible but read-only until tagged-release apply support lands: the Updates screen and API refuse stable apply with a clear message, and the update action states that installed apps keep running from their package snapshots and update separately from Apps.
- Shared MOS branding, Suite Manager UI primitives, active documentation ownership, and the MOS public site/docs source are consolidated under their canonical root-level locations.
- The rebuilt MOS public site (landing page and docs) replaces the MOS1 site as the deployed source for `myownsuite.org`: GitHub Actions builds `site/` from a clean install and deploys it to Cloudflare Pages from `main` and `staging` only, replacing Cloudflare's git-integration builds; the preserved MOS1 site is no longer built or deployed.

### Fixed

- Hardened app update interruption and rollback recovery, integrated-app updates, disabled-app and concurrent lifecycle handling, external app identity/configuration, source removal/orphan reporting, malformed privacy reviews, bounded large-file backup hashing, image/snapshot reclamation, and app runtime status truthfulness.
- Fixed public-cloud first-owner setup with automatic trusted HTTPS, a root-only one-time claim secret, secure cookies, firewall configuration, and a non-secret diagnostic instead of owner creation over public HTTP.
- Fixed DNS-01 and Homepage route reconciliation so MOS-owned links follow the active domain without rewriting user-authored links, and refreshed host services retain installed Home/state paths across managed updates.

### Security

- Official catalog and advisory files require offline Ed25519 verification against the public key shipped with the release. Invalid or missing signatures fail closed and create bounded owner-visible security state.
- External packages are rejected before build/apply when they request privileged containers, host paths/networking, devices, the Docker socket, raw proxy configuration, reserved identities, official-app impersonation, path escapes, or undeclared capabilities. Downloads use immutable revisions and enforce time, redirect, byte, file-count, extraction, canonical-path, and concurrency limits.
- Added bounded progressive login throttling by client and account, trusted-proxy handling, `Retry-After`, and secret-free hourly security aggregates with retention and storage caps. MFA and passkeys are not yet available.

### Compatibility

- Removed the temporary generation label from MOS-owned environment variables, runtime paths, services, sockets, containers, backup folders, smoke tooling, and documentation. Local prototype environments should be reset before validation.
- MOS paths now live at the repository root, and the former `suite-manager.<domain>/setup/` control-plane URL is replaced by `home.<domain>/suite-manager/`. The previous site and root layout remain isolated as rollback/reference material.
- The app-agent contract is version 9. App manifests may constrain `amd64`/`arm64`; package-aware backup schema 2 rejects pre-snapshot bundles; external routes use the reserved `ext-<host>` namespace; and releases must ship `trust/official-catalog.pub` with matching catalog/advisory signatures.
- USB installer owner fields were removed. Owner creation happens in the browser, and an unpinned machine login password is generated uniquely for each installer build.

### Known limitations

- MOS is beta. The Stable update track cannot apply tagged releases yet and is read-only in the Updates screen; platform updates deliberately leave installed apps on their package snapshots, with app updates applied separately per app.
- Backups are manual, whole-suite, unencrypted, destination-limited, and version-sensitive. Restore requires an already-installed compatible MOS version, and rollback is not guaranteed across data migrations.
- External packages remain unverified; publisher-key verification is not implemented; replay of a still-valid signed catalog revision is not cryptographically prevented; and a registry may stop serving a digest-pinned artifact retained by a package snapshot.
- Owner-run validation passed for the app catalog, external-package installation, the broader platform E2E flow, the full backup/restore recovery drills including replacement-machine restore, the hosted stable installer on a fresh cloud server (including the claim-token owner-setup gate), and a managed branch-track platform update on that install.
## [0.11.0] - 2026-06-07

### Changed

- Added a unified `agents/selfhost/` home for host agents and a repo-owned self-host service-agent path for narrow host service actions, starting with capability-detected Homepage restarts after Suite Manager saves runtime Homepage config. Compatibility note: self-host reconciliation now manages `mos-update-agent`, `mos-service-agent`, their `/run` sockets and `/etc` token files, and the Suite Manager agent env/socket mounts for existing and fresh USB/self-host installs; `update/selfhost/*` remains as compatibility wrappers.
- Began the offline backup/restore epic with a host-owned `mos-backup-agent`, Suite Manager Backup page, managed-infrastructure backup guidance when no agent is available, mounted external-destination detection, backup free-space preflight, cold Docker-volume archiving, detected backup-bundle listing, confirmed restore jobs with manifest/archive readability checks and pre-restore config rescue copies, and persistent backup/restore job state. Compatibility note: self-host reconciliation now manages `mos-backup-agent`, `/run/mos-backup-agent`, `/etc/mos-backup-agent/auth.token`, and the new `SUITE_MANAGER_BACKUP_AGENT_*` env/socket mounts.
- Improved backup destination handling so connected removable/USB block devices appear in Suite Manager even before they are mounted, and supported unmounted data partitions can be mounted into `/media/mos-backup` before starting a backup.
- Broadened backup destination discovery to include supported local data partitions and mounted network/shared storage under the backup paths, with capacity shown before mounting where Linux reports it.
- Limited Suite Manager backup destination discovery to usable backup storage, hiding optical, loop, EFI, active system partitions, and other non-actionable block devices while labeling remaining entries as external, local, or network storage.
- Refined Suite Manager backup status so disconnected or stale block-device mounts disappear after a rescan, duplicate mounted/unmounted entries are collapsed, and completed backup jobs show a compact activity summary with technical logs tucked behind details.
- Made the Updates screen capability-driven: Suite Manager now shows managed update actions only when the local update agent is reachable and advertises `updates.apply`, while hosted or agent-less installs stay in notify/manual-update guidance. Compatibility note: `SUITE_MANAGER_UPDATES_MODE` has been removed from active Suite Manager config and generated env templates.
- Retired the repo roadmap document in favor of GitHub Issues for roadmap-like task state, tightened the durable decision/agent docs around Homepage-driven proxy annotations, host-agent boundaries, temporary branch planning, local HTTPS/DNS-01 architecture, explicit Homepage URL ownership, and user-run E2E validation, replaced the temporary Homepage proxy annotations plan with maintained public Suite Manager guides, split self-host storytelling docs from the technical self-host README, and added Suite Manager validation plus capability-gated Customize UI preview for external-service `mos.proxy` Caddy annotations in Homepage tiles.
- Staged the generated external-proxy Caddy snippet path for future `mos.proxy` apply support while leaving static routes unchanged. Compatibility note: the VPS/local Caddy service now imports `deploy/vps/generated/caddy/*.caddy` through a read-only mount at `/etc/caddy/generated`, and `vps:init` seeds the ignored `external-proxies.caddy` file when missing.
- Added self-host service-agent support for applying generated external proxy routes after validation and Caddy reload, exposed through Suite Manager when the `external-proxies.apply` Caddy capability is available. Saving or resetting `services.template.yaml` now auto-applies saved proxy routes when that capability is reachable. Compatibility note: `mos-service-agent` now receives `MOS_SERVICE_AGENT_REPO_DIR` so it can write only the repo-owned generated Caddy snippet path.
- Added `npm run caddy:external-proxies:apply` so local/VPS operators can apply saved Homepage `mos.proxy` routes to the generated Caddy snippet, validate the mounted Caddy config, and reload Caddy without needing the self-host service agent.
- Added `vps:doctor` validation and focused smoke tests for generated external Caddy proxy snippets, including malformed snippets, duplicate generated hosts, and upstream URLs that would break Caddy validation.
- Simplified the Homepage Customize save flow so edited files can be validated any time while edited files must still pass validation before saving, external-service routing details stay behind a discreet advanced dialog, and the Homepage restart option only appears once changes are ready to save; added shared Suite Manager dialog, notice, stepper, text-input, and select controls plus a calmer stepped Customize helper for adding websites and home network apps with safer placement, automatic Homepage URL generation, structured app-subdomain metadata for managed home network apps, and icon guidance; documented the Suite Manager UI component reuse rule for future work.
- Added the first local HTTPS/DNS-01 foundation with a Cloudflare-capable Caddy build, generated Caddy built-in-route/global-options snippets, a Suite Manager Settings flow that can apply or reconfigure self-host HTTPS settings through the local service agent, and a shared `DOMAIN` / `PUBLIC_URL_SCHEME` / `MOS_TLS_MODE` contract for switching self-host installs from HTTP to Cloudflare DNS-01 HTTPS. Managed LAN-app proxy routes with `mos.public.mode: app-subdomain` now resolve their generated Caddy host from the same stack URL settings while explicit user-authored links stay untouched, and older Suite Manager-managed LAN-app tiles that still point at `*.mos.home` are upgraded to the current stack domain when Homepage config is read/exported. Compatibility note: the VPS/local Caddy service now reads `deploy/vps/services/caddy/.env`, `vps:init` refreshes `deploy/vps/generated/caddy/built-in-routes.caddy`, `global-options.caddy`, and known derived stack URL env values, and `MOS_TLS_MODE=cloudflare-dns01` requires `PUBLIC_URL_SCHEME=https`, a real domain, `CADDY_ACME_EMAIL`, and `CLOUDFLARE_API_TOKEN`.

### Fixed

- Allowed managed updates to recover when the only dirty working-tree file is the generated external-proxy Caddy snippet, which can happen on installs that applied `mos.proxy` routes before the snippet became ignored.
- Hardened the local E2E onboarding flow against Vaultwarden DOM and extension-setup route changes, and fixed Suite Manager onboarding copy buttons so successful clipboard actions reliably show copied feedback.

## [0.10.0] - 2026-05-29

### Changed

- Refreshed npm dependencies and pinned app container image digests across the suite, including Seafile 13 support, updated Seafile native database/admin/cache bootstrap settings, and current public docs and Suite Manager toolchain updates.
- Pinned the Cloudflare Pages Node.js build version in repo-managed Pages config so the Astro docs site builds with a supported Node 22 runtime.
- Swapped Seafile's local cache service from Memcached to Valkey using Seafile's Redis-compatible cache settings, including a system migration for existing own-infra installs. Compatibility note: the local/VPS service is now `seafile-valkey`, and Seafile cache env uses `CACHE_PROVIDER=redis` with `REDIS_*` variables instead of `MEMCACHED_*`.
- Added lightweight project tracking docs, documentation ownership rules, and a Codex-ready GitHub issue template so roadmap items, architecture decisions, and implementation tasks have clear sources of truth.
- Improved the self-host installer handoff so a simple local installer config can carry the chosen stack domain, Linux credentials, and Suite Manager owner credentials into a single first-boot manifest, feed bootstrap automatically, avoid leaving users hunting through generated env files after installation, help fetch the supported official Ubuntu Server ISO automatically when the local ISO folder is empty, and keep the USB installer menu human-confirmed instead of auto-starting after a timeout.
- Added the managed self-host updater MVP: USB/self-host installs now bootstrap a host-owned `mos-update-agent`, mount its Unix socket into Suite Manager through a generated Compose override, let the backend proxy managed update actions, and show subscribed update-track details, job diagnostics, and a first in-app `Update now` action in the Updates UI. Compatibility note: the self-host installer config and bootstrap flow now recognize `UPDATE_TRACK` and `UPDATE_REF` for experimental managed-update track selection, and self-host bootstrap now forces `SUITE_MANAGER_UPDATES_MODE=managed`.
- Added an explicit own-infra system migration phase for repo-managed VPS/self-host updates, keeping `.env.template` files as the latest app contract while moving historical compatibility fixes into named migrations.
- Strengthened managed self-host update application so updates explicitly rebuild all profiled stack images with fresh base pulls, recreate containers from those images, and remove obsolete Compose service containers without removing persistent volumes.
- Reprioritized the roadmap around real-install trust blockers: runtime Homepage YAML/CSS editing outside the source checkout and offline whole-suite backup/restore before managed updates become the default path for important app data.
- Moved Homepage customization to Suite Manager-owned runtime config seeded from bundled defaults and added a syntax-aware Customize screen for allow-listed YAML/CSS/JS edits with YAML save validation, so installed suites can change dashboard files without dirtying the production source checkout while preserving generated service-tile pruning. Compatibility note: Homepage now fetches config from Suite Manager at startup using `HOMEPAGE_CONFIG_SYNC_TOKEN`, while `services.yaml` remains generated from `services.template.yaml`.
- Added Umami analytics to the public landing and docs site without touching authenticated Suite Manager or bundled self-host app pages.
- Polished the public landing page mobile layout so the header, hero diagram, screenshots, and deploy-path cards stay readable on narrow phone screens.
- Documented and guarded the Seafile MySQL 8.x pin so Dependabot does not offer MySQL 9 updates before Seafile compatibility has been validated.

### Fixed

- Fixed Vaultwarden startup with the shared SMTP block disabled so refreshed images no longer fail on inactive mail settings.
- Fixed Suite Manager startup when Homepage runtime config uses the default state-directory-backed path.
- Hardened the self-host first-boot handoff so USB installer owner details are logged, exported, and loaded through a self-host Suite Manager env override instead of falling back to default onboarding identity values.
- Fixed self-host first-boot domain propagation so USB-installed Homepage tiles use the configured `*.mos.home` stack domain instead of stale `*.localhost` URLs.
- Fixed Railway-style ONLYOFFICE startup with newer Document Server images by preparing the admin panel supervisor log directories before upstream services start.
- Updated Vaultwarden Postgres to use the PostgreSQL 18 parent volume mount path for clean own-infra installs.
- Hardened the headed E2E onboarding flow so it waits for Suite Manager login and signed-in surfaces before checking onboarding state.

## [0.9.0] - 2026-04-17

### Changed

- Hardened the self-host installer path so the single-USB workflow no longer auto-takes over a machine without an explicit human choice, while also carrying the primary user into first-boot bootstrap and automatically starting the stack after fresh-machine setup finishes.
- Restored the rounded MOS screenshot-gallery corners in the docs by loading the shared branding tokens into the docs theme and enforcing the radius on the gallery media layers.
- Ignored the large local self-host ISO artifact folders so downloaded Ubuntu install media and generated installer ISOs do not get picked up in future commits.
- Clarified the Homepage app docs so the built-in search bar now explains its Startpage integration in plain language, including a short privacy-focused note and official reference links.
- Strengthened the public docs positioning around private-cloud ownership by rewriting the `Why your own cloud?` page in clearer, more convincing product language.
- Started the update-management foundation in Suite Manager with an `Updates` screen, a protected `/setup/api/updates` endpoint, bundled release metadata, and safe installed-versus-latest version comparison without giving the control plane host-level update powers yet.
- Made the Suite Manager updates foundation more deployment-aware by adding a platform-agnostic `SUITE_MANAGER_UPDATES_MODE`, improving local version-file discovery, and bundling release/version metadata into the Suite Manager image so hosted installs can accurately show notify-only update state.
- Added a test-only `SUITE_MANAGER_UPDATES_LATEST_VERSION_OVERRIDE` so the Updates screen can safely simulate "update available" states without changing the real release channel metadata.
- Added a repo-level `npm run release:check` guardrail plus CI coverage so `VERSION`, `releases/stable.json`, and `apps/suite-manager/release.json` stay aligned before releases.
- Started the manual self-host/VPS updater foundation with `npm run update:check`, `npm run update:status`, and explicit `npm run update:apply -- --target <version> --yes` commands, plus a local updater state file and preflight safety checks.
- Refactored Suite Manager onboarding around a dependency-based flow with grouped progress, keeping Vaultwarden credential setup first while unlocking separate Calendar, Files & Office, and Photos tracks afterward so users can continue with the part of the suite they care about most.
- Added an optional shared SMTP configuration block to the VPS/local stack so compatible apps can reuse one mail setup instead of forcing per-app email credentials; Seafile and Vaultwarden now consume that shared config for email-capable flows such as share links, verification mail, hints, and similar account notifications.
- Clarified the technical docs around the optional shared SMTP setup, including where advanced users should configure it, which apps benefit from it, and how the Railway, VPS, and self-host guides should point to the deeper operational notes without overloading the normal user flow.
## [0.8.0] - 2026-04-10

Milestone release: My Own Suite now has a validated self-host installation path on real home-server hardware over LAN, including the new single-USB installer tooling that helped bring the first end-to-end machine install together.

### Changed

- Validated the new self-host track on a real home server over LAN, building on the Ubuntu 24.04 bootstrap flow, canonical `appname.mos.home` and `appname.mos.<your-domain>` domain model, Cloudflare wildcard tunnel generator, and improved first-boot bootstrap behavior.
- Added an early single-USB installer builder that remasters an Ubuntu Server ISO with the MOS autoinstall seed, writes a dedicated `Install My Own Suite (ERASES DISK)` boot entry, and outputs a ready-to-flash installer image.
- Ignored local self-host ISO input and output artifact folders so downloaded Ubuntu media and generated installer images do not leak into future commits.
- Refined the public homepage, docs, and default Homepage experience with stronger MOS branding, restored screenshot-gallery polish, clearer app descriptions, better link defaults, a dedicated Management section for Suite Manager, and sharper private-cloud messaging.
- Hardened the default stack against unnecessary third-party calls by removing Google-hosted fonts and remote Homepage icons, disabling Vaultwarden relay-based mobile push, and turning off Stirling PDF analytics by default.
- Fixed the Suite Manager Vaultwarden credential-import onboarding flow, expanded E2E coverage around that live-session sync path, and corrected a runtime string-syntax bug that blocked `suite-manager` smoke startup.
- Clarified Homepage search documentation with a plain-language Startpage explanation and official reference links.

## [0.7.1] - 2026-03-29

### Changed

- Expanded the Railway deployment guide with clearer official-template support material, including the canonical public deploy URL, annotated setup screenshots for the required owner inputs, and a calmer plain-language explanation of resource usage and cost expectations.

## [0.7.0] - 2026-03-29

### Added

- Started the dedicated self-host track with an Ubuntu 24.04 bootstrap path, a canonical `appname.mos.home` and `appname.mos.<your-domain>` domain model, Cloudflare wildcard tunnel scaffolding, and an early unattended-install flow for testing the appliance-style setup on fresh machines.

### Changed

- Hardened the default stack against unnecessary third-party calls by removing Google-hosted fonts and remote Homepage icons, disabling Vaultwarden relay-based mobile push, and turning off Stirling PDF analytics by default.
- Refined the public homepage, root README, deployment/docs screenshot coverage, and default Homepage experience with stronger MOS branding, clearer app descriptions, better link defaults, a dedicated Management section for Suite Manager, and a tighter trust story around the bundled apps.

### Fixed

- Fixed a Suite Manager onboarding regression so the Vaultwarden credential-import step now advances correctly after manual confirmation, and expanded the E2E coverage to catch the same live-session UI sync bug in the future.

## [0.6.0] - 2026-03-27

### Changed

- Redesigned the public homepage into a full product landing page with a stronger hero, clearer narrative sections, a concrete module grid, and preserved built-with attribution so the suite feels like a polished product instead of an MVP placeholder.
- Introduced a shared MOS design-system foundation with documented tokens and ownership rules, then aligned the public site, docs theme, and Suite Manager around more consistent type roles, spacing, radii, panels, labels, and meta text.
- Refreshed the OnlyOffice screenshot set with sharper 1080p captures across the docs and landing-page galleries, improving how the suite looks in release materials and app previews.

## [0.5.0] - 2026-03-24

### Changed

- Refreshed the public site and app pages with stronger MOS branding, real product screenshot galleries, and clearer end-user documentation around deployment and core apps.
- Improved the first-run Suite Manager flow by importing the control-plane credentials into Vaultwarden, clarifying the user-facing control-plane naming, and smoothing the credential handoff experience.
- Streamlined local validation and manual testing with clearer E2E command docs, a new onboarding-manual flow that pauses on Homepage, and a smaller interactive command set.
- Changed the default Docker Compose project name for the normal stack to `mos`. Compatibility note: generated Compose resources such as the default network and named volumes now use the `mos_` prefix instead of `vps_`.
- Hardened local cross-platform behavior with simpler `*.localhost` routing and Windows-friendly line-ending safeguards for scripts and container entrypoints.

## [0.4.0] - 2026-03-18

### Added

- Added a real `suite-manager` control-plane with owner sign-in, persistent onboarding state, and a guided first-run setup flow.
- Added real Docker-backed Playwright E2E coverage for the onboarding flow and Homepage-driven app verification.

### Changed

- Reworked the suite access flow so Suite Manager is now the single login and control-plane entrypoint, with Homepage linking back into the `/setup/` experience.
- Improved onboarding with Vaultwarden-first setup, guided Radicale calendar connection, clearer completion behavior, and a simpler escape path back to Homepage.
- Tightened local/VPS validation and CI so generated env files, required Suite Manager auth inputs, and compose checks stay aligned with the real first-run flow.
- Clarified public-facing deployment messaging so the docs now distinguish the current maintained VPS/local stack from earlier Railway validation work.
- Reworked the public docs around a more beginner-friendly setup flow, including separate guides for Railway, VPS, and self-hosted hardware.
- Strengthened the public docs language around hosted infrastructure, privacy boundaries, and why Railway or a VPS still differ from consumer Big Tech cloud ecosystems.
- Added a short plain-language explanation of why a Google/Microsoft/Apple alternative still needs a cloud runtime for sync, backup, and multi-device access.
- Simplified the early cloud explainer around a clearer ownership message and added an optional further-reading link for people who want more background.
- Moved the private-cloud explanation into the main `What is` flow and added a dedicated plain-language explainer page about why this differs from Google, Microsoft, or Apple cloud products.
- Reworked the plain-language cloud explainer around a safer and more relatable bank safe-deposit-box analogy.
- Added a short `Is My Own Suite free?` section to explain the difference between free software and optional hosting costs.
- Updated docs and repo guidance to match the current Suite Manager-first architecture, `Technical reference` app docs pattern, and discoverable root E2E commands.
- Replaced the Suite Manager bootstrap-token gate with built-in owner email/password auth, a signed session cookie, and a `/setup/` control-plane surface that can proxy Homepage after login. Compatibility note: `BOOTSTRAP_TOKEN` has been removed from the suite-manager env contract and replaced by required `OWNER_PASSWORD` and `SESSION_SECRET` inputs; Homepage `SUITE_MANAGER_URL` now needs the `/setup/` suffix.
- Simplified the Suite Manager Homepage contract so it now uses only `HOMEPAGE_URL` for the private Homepage upstream. Compatibility note: `HOMEPAGE_PUBLIC_URL` has been removed from the suite-manager env contract.
- Refreshed Homepage defaults with MOS styling, a lighter top bar, a built-in `theme-mos` palette, simpler datetime formatting, and no weather prompt.
- Added shared `suite-manager` onboarding env inputs (`OWNER_NAME`, `OWNER_PASSWORD`, `SESSION_SECRET`, `SUITE_MANAGER_PUBLIC_URL`, `SUITE_MANAGER_STATE_DIR`) and expanded the suite-manager runtime env surface to consume existing Vaultwarden, Seafile, and Radicale bootstrap data.
- Changed local/VPS Vaultwarden routing so it now uses HTTPS and advertises an HTTPS public URL, which is required for the web signup flow to work correctly.
- Updated the Homepage base image pin to the `v1.8.0` release digest to test whether newer upstream runtime behavior fixes the custom search widget regression.

## [0.3.0] - 2026-03-09

### Added

- Added a minimal `apps/suite-manager` Node/TypeScript service that exposes a status endpoint and logs periodic Homepage health checks, providing a concrete deployment target for future shared bootstrap and monitoring work.

### Changed

- Documented a `staging` integration branch workflow so feature branches can be tested and batched before promotion to `main` releases.
- Reworked VPS/local setup around `suite-manager` shared inputs and service-level `deploy/vps/services/*.env.template` files, replacing the older app-level runtime env layout.
- Simplified `vps:init` and `vps:doctor` to match the new template structure and dropped the remaining legacy `.env.example` compatibility code.
- Fixed `npm run vps:rebuild` so clean-slate rebuilds also remove profiled service volumes and auth state.

## [0.2.0] - 2026-03-08

### Added

- New root scripts for safer VPS onboarding:
  - `npm run vps:init` to create missing `deploy/vps/**/*.env` files from `.env.example` templates without overwriting existing values.
  - `npm run vps:doctor` to validate required env vars and cross-file configuration checks before startup.
  - `npm run vps:up` to run a non-destructive full stack startup flow (`init` + `doctor` + compose up).
- `vps:init` now renders template expressions in `.env.example`, including:
  - `secret(length[, alphabet])`
  - `secret(name, length[, alphabet])` for shared generated values across files
  - `base64(text)` for derived values (for example `username:password` auth headers)

### Changed

- Updated VPS onboarding documentation to use the new `vps:init -> vps:doctor -> vps:up` flow and keep `vps:rebuild` as an explicit destructive reset command.
- Updated app `.env.example` templates to support generated shared secrets and derived values during first-time setup.
- Updated CI compose validation to render and verify VPS env files before running `docker compose config`.

## [0.1.0] - 2026-03-04

First official release of My Own Suite.
Establishes the release/publishing foundation and ships the initial MVP application stack, validated locally with Docker Compose and in a Railway cloud deployment.

### Added

- `RELEASING.md` with SemVer rules, compatibility contracts, and a clear release workflow.
- `CHANGELOG.md` as the canonical release history.
- Starlight docs `Releases` page rendering `CHANGELOG.md`.
- Top-level `Project` docs section (after `Apps`) containing `Releases`.
- Git hooks (`pre-commit`, `pre-push`) to block commits/pushes directly on `main`.
