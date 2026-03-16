# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Added

- Added a real `suite-manager` control-plane app with owner sign-in, persistent onboarding state, and a guided first-run setup flow.
- Added Vaultwarden-first onboarding with automatic account detection, assisted credential import, and follow-up Radicale calendar setup guidance.
- Added shared MOS styling reuse between the Astro site and `suite-manager`, including onboarding status icons and updated app-shell styling.
- Added local E2E runner commands and test docs for the Docker-backed Playwright onboarding flow so it is easier to run headed during manual verification and release work.
- Added a Homepage-driven Playwright app verification flow that brings up the real local stack and checks Suite Manager, Vaultwarden, Seafile, Stirling PDF, Immich, and Radicale through their live user-facing routes.

### Changed

- Aligned Homepage config and project docs with the current Suite Manager-first architecture by removing stale Authelia references, fixing the Suite Manager resource URL contract, and normalizing app-page `References` sections.
- Restored clearer user-facing docs wording by switching app pages back to `Technical reference` headings and keeping Homepage operational commands easy to type from the repo root.
- Updated the Suite Manager CI smoke test to supply the required auth env vars and build the setup frontend before startup so staging catches control-plane regressions earlier.
- Changed the Suite Manager VPS env template so `OWNER_PASSWORD` is auto-generated during `vps:init` instead of shipping as a failing placeholder, which keeps compose validation aligned with the first-run setup flow.
- Added a real local Playwright E2E harness that starts a Docker-based test stack on alternate ports and drives the Suite Manager onboarding flow without source-code test hooks or readiness bypasses.
- Expanded the local Playwright E2E harness to isolate the Immich and Stirling PDF containers too, split reusable onboarding helpers out of the first spec, and expose dedicated root commands for onboarding, Homepage app verification, and full-suite runs.
- Replaced the Suite Manager bootstrap-token gate with built-in owner email/password auth, a signed session cookie, and a `/setup/` control-plane surface that can proxy Homepage after login. Compatibility note: `BOOTSTRAP_TOKEN` has been removed from the suite-manager env contract and replaced by required `OWNER_PASSWORD` and `SESSION_SECRET` inputs; Homepage `SUITE_MANAGER_URL` now needs the `/setup/` suffix.
- Simplified the Suite Manager Homepage contract so it now uses only `HOMEPAGE_URL` for the private Homepage upstream. Compatibility note: `HOMEPAGE_PUBLIC_URL` has been removed from the suite-manager env contract.
- Removed Authelia from the active local/VPS stack so Suite Manager is now the single login and public control-plane entrypoint.
- Improved onboarding flow behavior with Vaultwarden import auto-detection, completion snackbars, brief detecting states, and step-driven detection rules that keep the UI stable while users move between apps.
- Added the first Radicale onboarding flow with device-specific guidance, QR helpers where useful, and a manual completion path after credential import.
- Refreshed Homepage defaults with MOS styling, a lighter top bar, a built-in `theme-mos` palette, simpler datetime formatting, and no weather prompt.
- Moved the Suite Manager Homepage link into the resources area and updated it to open the Suite Manager `/setup/` route.
- Updated end-user and VPS docs to reflect the new onboarding-first access flow, including local Vaultwarden HTTPS behavior.
- Added shared `suite-manager` onboarding env inputs (`OWNER_NAME`, `OWNER_PASSWORD`, `SESSION_SECRET`, `SUITE_MANAGER_PUBLIC_URL`, `SUITE_MANAGER_STATE_DIR`) and expanded the suite-manager runtime env surface to consume existing Vaultwarden, Seafile, and Radicale bootstrap data.
- Changed local/VPS Vaultwarden routing so it now uses HTTPS and advertises an HTTPS public URL, which is required for the web signup flow to work correctly.
- Simplified the onboarding escape hatch to a single warning-confirmed `Skip onboarding` button that just returns the user to Homepage instead of mutating onboarding state.
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
