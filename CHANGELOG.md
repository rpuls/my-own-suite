# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Changed

- Fixed a Suite Manager onboarding regression so the Vaultwarden credential-import step now advances correctly after manual confirmation, and expanded the E2E coverage to catch the same live-session UI sync bug in the future.
- Hardened the default stack against unnecessary third-party calls by removing Google-hosted fonts and remote Homepage icons, disabling Vaultwarden relay-based mobile push, and turning off Stirling PDF analytics by default.
- Refined the public homepage and default Homepage experience with stronger MOS branding, clearer app descriptions, better link defaults, a dedicated Management section for Suite Manager, and a tighter trust story around the bundled apps.
- Started the dedicated self-host track with an Ubuntu 24.04 bootstrap script, a canonical `appname.mos.home` and `appname.mos.<your-domain>` domain model, a Cloudflare wildcard tunnel config generator, and an unattended-install flow that now covers more of the first-boot domain setup, Docker access, and stack startup work on fresh machines.
- Fixed the first self-host autoinstall bootstrap attempt so the first-boot service can clone the repo before trying to run the MOS bootstrap script on a fresh machine.
- Clarified the Homepage app docs so the built-in search bar now explains its Startpage integration in plain language, including a short privacy-focused note and official reference links.
- Strengthened the public docs positioning around private-cloud ownership by rewriting the `Why your own cloud?` page in clearer, more convincing product language.

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
