# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Changed

- Improved the self-host installer handoff so a simple local installer config can carry the chosen Linux and Suite Manager owner credentials into the USB build, feed first-boot bootstrap automatically, avoid leaving users hunting through generated env files after installation, help fetch the supported official Ubuntu Server ISO automatically when the local ISO folder is empty, and keep the USB installer menu human-confirmed instead of auto-starting after a timeout.
- Started the managed self-host updater MVP track with an isolated `update/selfhost` workspace, a phased plan for a host-owned update agent, an experimental self-host update-track foundation so USB-installed test machines can follow either published releases or a configured branch without giving the Suite Manager container direct host control, and a first bootstrap-installed `mos-update-agent` systemd service that exposes a local Unix-socket update API on self-host machines. Compatibility note: the self-host installer config and bootstrap flow now recognize `UPDATE_TRACK` and `UPDATE_REF` for experimental managed-update track selection, and self-host bootstrap now forces `SUITE_MANAGER_UPDATES_MODE=managed`.
- Extended the managed self-host updater MVP so self-host bootstrap now generates a Compose override that mounts the host update agent into Suite Manager, the backend can proxy managed update actions to that agent, and the Updates UI can show the subscribed track plus a first in-app `Update now` action for managed self-host installs.

### Fixed

- Hardened the self-host first-boot handoff so USB installer owner details are logged, exported, and written into Suite Manager's env file reliably instead of falling back to default onboarding identity values.

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
