# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Added

- Added a real `suite-manager` control-plane with owner sign-in, persistent onboarding state, and a guided first-run setup flow.
- Added real Docker-backed Playwright E2E coverage for the onboarding flow and Homepage-driven app verification.

### Changed

- Reworked the suite access flow so Suite Manager is now the single login and control-plane entrypoint, with Homepage linking back into the `/setup/` experience.
- Improved onboarding with Vaultwarden-first setup, guided Radicale calendar connection, clearer completion behavior, and a simpler escape path back to Homepage.
- Tightened local/VPS validation and CI so generated env files, required Suite Manager auth inputs, and compose checks stay aligned with the real first-run flow.
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
