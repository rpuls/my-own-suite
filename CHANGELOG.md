# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Changed

- Added the first V2 managed-update path: new V2 installs get a local `mos-v2-update-agent`, Suite Manager exposes an Updates page with branch-track switching, progress, changelog summaries, and advanced logs, and update jobs can fast-forward the V2 lab branch, rebuild Suite Manager, and reconcile repo-owned systemd services/host agents/Caddy wiring. Compatibility note: this first V2 slice preserves installed app runtimes and reports that package runtime reapply/restart remains a manual post-update step when manifests or Dockerfiles change.
- Condensed the V2 branch documentation by replacing oversized temporary research/roadmap docs with a compact active lab plan and durable app-package/integration decisions, added temporary V2 backup/restore research for a package-aware whole-suite backup model, and introduced the first V2 Backup page backed by a host-owned backup agent. Owners can choose connected storage, mount supported backup drives, start a whole-suite backup, see recent backups, download a backup bundle, and explicitly restore a detected backup; restore now recreates installed app runtimes after state and app data are restored, restarts the control plane if runtime restore fails, keeps the confirmation input focused while typing, and blocks the page with clear progress feedback during backup and restore, while technical manifest, state, app-volume, relationship, and warning details stay behind Advanced details. The Hyper-V smoke harness now provisions and mounts a disposable backup disk automatically so the backup destination flow can be tested without manual Hyper-V Manager steps.
- Streamlined V2 Suite Manager UI styling around the canonical MOS branding palette, replacing ad hoc feature-level colors with a small shared set of surface, focus, status, spacing, and shadow tokens.
- Added a two-command USB-aligned Hyper-V smoke lifecycle pinned to `feat/app-platform-v2-lab`: `reset` renders the V2 bootstrap into a smoke-only auto-boot Ubuntu installer without the v1 self-host handoff, replaces and starts the disposable VM with disk-before-DVD reboot safety, discovers its IP through integration data or the VM MAC's Windows neighbor entry, waits for the V2 Suite Manager endpoint, and installs a marked Windows hosts entry for the printed Home URLs plus discovered local app-package route hosts, while `destroy` removes the exact VM, lab artifacts, and hosts entry.
- Started a clean root-level `version-2/` workspace for building the Suite Manager-first launch platform separately from the existing suite code, with product-level ownership, canonical V2 branding, browser-created owner authentication, a React/Vite control-plane shell, and a tested no-preconfig installer foundation for cloud-init, SSH/bootstrap, USB seed, DigitalOcean smoke validation. The V2 control plane now starts repo-built Cloudflare-capable Caddy and a digest-pinned private Homepage runtime on one authenticated Home origin, serves Suite Manager at `/suite-manager/` with responsive Dashboard/Customize/Settings/sign-out navigation, stores owner/session, operation/revision metadata, and non-secret HTTPS state in migrated transactional SQLite, and applies post-install Cloudflare DNS-01 HTTPS plus allowlisted Homepage YAML edits and guided dashboard links/home services through separate restricted rollback-capable root agents. Homepage customization now follows the proven V1 file-rail, syntax-aware validation/save, shared Add dialog, link, and home-network URL-helper workflow while retaining V2 revisions and agent boundaries; it keeps durable dashboard YAML as its source, generates `services.yaml` and a separate MOS-owned Caddy route snippet transactionally, validates/reloads Caddy only when routes change, and preserves DNS-01 ownership. Focused HTTP, WebSocket, persistence, renderer, agent, installer, branding, and V2-owned Playwright foundations cover these boundaries without installer-time credentials, optional apps, direct Homepage bypasses, or test-only application behavior, while fresh DigitalOcean installs overlap the pinned Homepage pull with control-plane builds and allow 30 minutes for cold-machine readiness. The V2 roadmap now defines the app-package direction around self-contained `version-2/apps/<app-id>/` packages, schema-driven setup/onboarding UI for common cases, SQLite app instance state, redacted secret references, deterministic Compose/Caddy/Homepage projections, narrow lifecycle-agent apply, and a first boring app lifecycle before any catalog/store; the first scaffold adds local manifest discovery/validation guardrails, a self-contained Stirling PDF package manifest/Dockerfile/docs as that lifecycle candidate, a disposable Apps page that exposes real package validation/details, generic SQLite instance/config/projection/operation state for logical installs with dry-run projections before host mutation exists, a temporary installed-app action that applies the stored Homepage projection through the existing Homepage agent boundary, app host smoke tooling that keeps app hosts inside the Hyper-V smoke hosts block and repairs stale app host entries after fresh VM resets, and a narrow `mos-v2-app-agent` runtime apply path that builds/runs one Dockerfile-backed app package on a deterministic package loopback port, writes package-scoped blocks into the separate app Caddy routes file, applies package-declared environment values, reloads Caddy, probes health, and marks runtime projections applied only after the host state is real. DNS-01 agent applies now render a concrete Suite Manager upstream port for post-install Caddy validation, verify Cloudflare access through zone lookup instead of user-token-only verification, restart Caddy so the newly written Cloudflare secret environment is loaded, recover the Settings UI from the expected bootstrap-origin connection drop once SQLite records the apply as successful, and present this path as private LAN HTTPS only: self-host installs show the detected server IP plus Windows hosts-file and AdGuard/Unbound/router DNS override guidance before opening the new HTTPS Home URL, while cloud/external-provider installs hide and block the DNS-01 apply form and direct custom-domain HTTPS setup to the provider guide instead. Compatibility note: the pre-release V2 `suite-manager.<domain>` host and `/setup/` Home path are replaced by `home.<domain>/suite-manager/`; existing pre-release `platform-state.json` owner/session state is imported once and retained as `platform-state.json.migrated`; V2 adds SQLite migration metadata plus the `mos-v2-homepage-agent` socket/service, `mos-v2-app-agent` socket/service, `/etc/caddy/mos-v2-homepage-routes.caddy`, and `/etc/caddy/mos-v2-app-routes.caddy` imports; the Caddy service no longer starts with `--environ`, preventing secret environment values from being printed to journald; and Suite Manager is no longer stop-coupled to Homepage while customization restarts use coordinated 60/75-second agent/client budgets, preventing valid edits from rolling back at the former 20-second deadline.
- Reworked the V2 Suite Manager Apps surface from a lifecycle-debug page into a real app catalog with search, category and status filters, app cards, detail drawers, a Prepare-to-install setup flow for user-supplied package fields, privacy/setup/resource presentation, related-app slots, one coherent install flow over the existing package lifecycle actions, and advanced technical details kept behind disclosures; package manifests now support optional structured `catalog` metadata for richer presentation without making screenshots or marketing copy mandatory.
- Hardened V2 app lifecycle status truthfulness with an authenticated runtime status refresh that asks the narrow app agent to re-check an installed app's health projection, records healthy or failed validation state in SQLite, prevents stale applied projections from continuing to appear as Running after a detected app crash, and uses one shared app health indicator so catalog LEDs and detail badges show the same state. The V2 app lifecycle now also supports stop, start, restart, and uninstall actions while preserving data/config/secrets by default; stop removes only app containers while keeping the Homepage shortcut in place, preserved-data uninstall removes the app runtime, app Caddy route block, and MOS-owned Homepage shortcut, and destructive data deletion remains future explicit work.
- Added a one-command V2 Suite Manager local run path that builds the frontend, starts the backend, prints the `home.localhost` browser URL, and reports occupied ports with a clear message.
- Added Vaultwarden and Radicale as V2 app packages after Stirling PDF, extending the generic package contract with generated and user-supplied secret setup fields, redacted persisted app config, secret-placeholder runtime projections, package onboarding metadata, controlled missing-secret runtime failures, and tests that keep Suite Manager core free of app-specific dependencies while preserving earlier package behavior. Radicale also validates manifest-driven Homepage widgets through a constrained calendar widget and structured tokenized iCal bridge, keeping credentials out of public projections while restoring the calendar view from the V1 Homepage experience; the V2 planning docs now narrow post-install guidance toward a lightweight Radicale-style guide system for client setup instructions, copyable non-secret values, QR support, and complete/skip state without carrying forward V1 Vaultwarden credential import.
- Added Seafile core as the first V2 multi-service app package, with package-owned Seafile/MySQL/Valkey services, internal-only dependency containers, generated database/JWT secrets, user-supplied initial Seafile admin credentials, preserved Seafile/MySQL volumes, one public app route, and a generic app-agent multi-service apply/remove path. V2 now also includes ONLYOFFICE as an independent capability-provider app package plus a first capability-based integration flow that connects running ONLYOFFICE and Seafile installs, grants Seafile the provider JWT secret without exposing it in public API responses, patches Seafile's allowlisted runtime config, attaches ONLYOFFICE to Seafile's package network for server-to-server document traffic, reapplies Seafile, and records explicit relationship state.
- Hardened V2 app-to-app integrations so provider/consumer restart and re-enable revalidate active relationships, stop/disable/uninstall no longer leave relationships falsely connected, and companion/capability-provider packages such as ONLYOFFICE are grouped separately without useless Homepage shortcut controls.
- Prefilled V2 app install email setup fields from the Suite Manager owner email while keeping the values editable before install.
- Documented the V2 capability-based app compatibility and app-to-app integration direction, using Seafile plus OnlyOffice as the first concrete case while keeping OnlyOffice implementation deferred.
- Added the first V2 post-install setup guide slice: package manifests can expose structured guide sections, Radicale shows connection details and explicit client-specific CalDAV/CardDAV instructions from the Apps detail drawer, the guide opens in a readable side panel with maintenance actions tucked behind a kebab menu, and Suite Manager persists guide viewed/completed/skipped state per app instance.
- Added a reusable DigitalOcean smoke-test harness with `npm run smoke:do:reset` and `npm run smoke:do:destroy` for creating or replacing a tagged Ubuntu 24.04 Droplet, running the cloud self-host installer from a selected repo ref, saving local logs/state, and safely cleaning up only MOS smoke resources.
- The DigitalOcean smoke-test harness now auto-loads `.mos-smoke/digitalocean.env` so local token and SSH settings do not need to be exported manually before `up` or `destroy`.
- Documented the Codex workflow for SSH inspection of disposable V2 Hyper-V smoke VMs, including password-based `plink` access from the local installer config and guidance to avoid unnecessary SSH key setup inside the VM.
- Documented the deployment-path convergence direction: Platform deployments remain secondary and currently Railway-focused, while cloud-machine and own-hardware installs should share one Ubuntu 24.04 self-hosted own-infra runtime with USB and cloud-init style installers instead of separate VPS and self-host systems; added early cloud-server installers through `npm run selfhost:cloud-init` provider user-data generation and a fresh-server SSH bootstrap script, routed USB/cloud-init/SSH installs through one shared self-host installer core after `/etc/mos-selfhost.env` exists, captured the alpha direction toward control-plane-first installs with Suite Manager app catalog provisioning, and removed the abandoned `selfhost:cloudflared` tunnel generator from the supported script surface.
- Improved the Suite Manager Updates screen with UI track switching between stable releases and staging, separate stable-release and branch-commit targets, changelog-based change summaries, and technical update logs tucked behind advanced details, while splitting Backup and Restore into clearer top-level workflow cards. Compatibility note: `mos-update-agent` now advertises `updates.configure-track`, writes the selected track to `.mos-updater/config.json` through its local-only API, and managed updates now refresh host agents during system migration so new host-side code is applied with the rest of the update.
- Added a development-only simulated self-host agent stack for local UI review, enabled with `npm run vps:up -- --simulateSelfHost` or `npm run vps:rebuild -- --simulateSelfHost`, so Suite Manager can preview update, service, and backup-agent capability states without real host agents.
- Updated Vaultwarden to the current `1.36.0` server image for newer Bitwarden client compatibility and upstream security fixes.

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
