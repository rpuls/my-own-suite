# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Added

- Added a real `suite-manager` onboarding surface for VPS/local deployments, including a Homepage `Finish Setup` entry, persistent onboarding state, a React/Vite frontend, and a lightweight Hono-based service scaffold for future suite-management features.
- Added guided first-run access onboarding around Vaultwarden, including automatic account detection, a visible step-stack UI, and an assisted credential handoff flow for generated Seafile and Radicale accounts.
- Added shared MOS styling reuse between the Astro site and `suite-manager`, plus lightweight SVG onboarding status icons using `lucide-react`.
- Added an `authelia` service, docs page, Caddy integration, and env templates so Homepage and Suite Manager can sit behind a shared login gateway.

### Changed

- Replaced the Suite Manager bootstrap-token gate with built-in owner email/password auth, a signed session cookie, and a `/setup/` control-plane surface that can proxy Homepage after login. Compatibility note: `BOOTSTRAP_TOKEN` has been removed from the suite-manager env contract and replaced by required `OWNER_PASSWORD` and `SESSION_SECRET` inputs; Homepage `SUITE_MANAGER_URL` now needs the `/setup/` suffix.
- Refreshed the default Homepage landing page with MOS-branded custom CSS, a denser but still restrained widget set (greeting, system glance, datetime, search), and user-selectable Homepage theme/color controls instead of a fixed palette.
- Removed the default Homepage weather widget so the dashboard no longer prompts the user for location access.
- Simplified the Homepage top bar so the date and search widgets render without the boxed header treatment.
- Added a `theme-mos` Homepage palette with first-run default bootstrapping via `custom.js`, and shortened the default datetime widget format to reduce top-bar width.
- Added shared `suite-manager` onboarding env inputs (`OWNER_NAME`, `OWNER_PASSWORD`, `SESSION_SECRET`, `SUITE_MANAGER_PUBLIC_URL`, `SUITE_MANAGER_STATE_DIR`) and expanded the suite-manager runtime env surface to consume existing Vaultwarden, Seafile, and Radicale bootstrap data.
- Changed local/VPS Vaultwarden routing so it now uses HTTPS and advertises an HTTPS public URL, which is required for the web signup flow to work correctly.
- Updated setup and VPS docs to reflect the new onboarding-first flow and local Vaultwarden HTTPS behavior.
- Refactored suite-manager onboarding into smaller `main`, `shared`, and `vaultwarden` modules on both the backend and frontend so future onboarding categories such as Radicale can be added without growing single large files.
- Added a first Radicale onboarding category with an Android QR helper, manual fallback setup details, and explicit completion flow after Vaultwarden credential import.
- Improved Radicale onboarding guidance so each device path now explains how to add the account inside the calendar client instead of opening the server URL as a browser page.
- Refined the Radicale device selector and copy to recommend concrete apps per platform: Apple Calendar on iPhone/iPad and Mac, DAVx5 plus a calendar app on Android, and Thunderbird on Windows.
- Simplified the onboarding escape hatch to a single warning-confirmed `Skip onboarding` button that just returns the user to Homepage instead of mutating onboarding state.
- Fixed the Homepage `Finish Setup` tile to use an explicit `SUITE_MANAGER_URL` env var instead of a VPS-only `${DOMAIN}` placeholder, so the tile can also work correctly on Railway.
- Updated the Homepage base image pin to the `v1.8.0` release digest to test whether newer upstream runtime behavior fixes the custom search widget regression.
- Changed the default local root domain from `localhost` to `mos.localhost` so shared auth cookies can work across protected subdomains, and added a required `OWNER_PASSWORD` shared env input for the initial login.
- Rebranded the Authelia browser tab title to `Login - My Own Suite` via an asset override and added the Authelia logo to the docs app page styling.
- Added an explicit `MOS_AUTHELIA_THEME` env input so the stock Authelia portal themes can be switched without editing container code.

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
