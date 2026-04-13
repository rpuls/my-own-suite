#### Environment variables

- `PORT`: HTTP port for the suite-manager status endpoint. Defaults to `3000`.
- `HOMEPAGE_URL`: Homepage URL to probe. Defaults to `http://homepage:3000/`.
- `SUITE_MANAGER_CHECK_INTERVAL_MS`: Homepage probe interval in milliseconds. Defaults to `300000`.
- `SUITE_MANAGER_REQUEST_TIMEOUT_MS`: Timeout per Homepage request in milliseconds. Defaults to `10000`.
- `SUITE_MANAGER_RUN_ONCE`: If set to `true`, performs one Homepage check and exits. Useful for smoke tests.
- `OWNER_NAME`: Display name shown in the onboarding flow.
- `OWNER_EMAIL`: Shared owner email shown in onboarding and reused by compatible app bootstrap flows.
- `OWNER_PASSWORD`: Owner password used for Suite Manager sign-in.
- `SESSION_SECRET`: HMAC secret used to sign the Suite Manager session cookie.
- `SUITE_MANAGER_PUBLIC_URL`: Public onboarding URL surfaced in the UI.
- `SUITE_MANAGER_BASE_PATH`: Public path for the Suite Manager setup surface. Defaults to `/setup`.
- `SUITE_MANAGER_SESSION_COOKIE_NAME`: Optional override for the session cookie name. Defaults to `mos-suite-manager-session`.
- `SUITE_MANAGER_SESSION_MAX_AGE_SECONDS`: Optional session lifetime in seconds. Defaults to `1209600` (14 days).
- `SUITE_MANAGER_STATE_DIR`: Directory used to persist onboarding progress.
- `SUITE_MANAGER_UPDATES_ENABLED`: Optional toggle for live GitHub release checks. Defaults to `true`.
- `SUITE_MANAGER_GITHUB_REPO`: Repository used for release checks. Defaults to `rpuls/my-own-suite`.
- `SUITE_MANAGER_UPDATES_MODE`: Update-management posture for this installation. Use `notify-only` for Railway-like platforms or any deployment where Suite Manager should only notify about newer releases; reserve `managed` for future host-side updater integrations. Defaults to `notify-only`.
- `SUITE_MANAGER_UPDATES_LATEST_VERSION_OVERRIDE`: Optional test-only override for simulating the latest available version in the Updates screen without changing real release metadata.
- `VAULTWARDEN_DATABASE_URL` or `DATABASE_URL`: Optional Postgres connection string used to detect when the owner Vaultwarden account has been created. In the VPS/local stack, this is sourced from the existing Vaultwarden service env.
- `SEAFILE_ADMIN_EMAIL`, `SEAFILE_ADMIN_PASSWORD`, `RADICALE_ADMIN_USERNAME`, `RADICALE_ADMIN_PASSWORD`: Consumed from existing service env files so suite-manager can prepare the first Vaultwarden import handoff.
- `DOMAIN` / `PUBLIC_URL_SCHEME`: Optional fallback inputs for deriving public app URLs when explicit `*_PUBLIC_URL` values are not set.

#### Health and behavior

- Serves the React/Vite setup frontend on `/setup/`.
- Uses a built-in email/password login with a signed cookie session.
- Proxies Homepage through `/` after the owner signs in.
- Exposes a simple HTTP `200` health endpoint on `/healthz`.
- Exposes JSON setup auth/status/onboarding data on `/setup/api/auth/*`, `/setup/api/status`, and `/setup/api/onboarding`.
- Exposes JSON update state on `/setup/api/updates`, including installed version, latest release metadata, and whether an update is available.
- Supports platform-agnostic notify-only update behavior so hosted deployments can show update availability without implying that Suite Manager can perform the installation itself.
- Logs a success line when Homepage returns a `2xx` response.
- Logs a failure line when Homepage returns a non-`2xx` response or the request errors.
- Persists onboarding step completion in `SUITE_MANAGER_STATE_DIR`.
- Automatically advances past Vaultwarden account creation when the configured Vaultwarden database shows a user matching `OWNER_EMAIL`.
- Serves a Vaultwarden-compatible CSV import artifact for the generated accounts currently available to suite-manager, and the frontend can copy that content directly to the clipboard for paste-based import after login.
- Falls back to the bundled `releases/stable.json` manifest when a live GitHub release lookup is unavailable.

#### Development structure

- Uses `Hono` for the backend API and service runtime.
- Uses `React` + `Vite` for the frontend onboarding app.
- `src/index.ts`: process entrypoint and lifecycle wiring.
- `src/app.ts`: top-level route registration.
- `src/config.ts`: environment parsing and public URL derivation.
- `src/features/onboarding/*`: onboarding state, domain model, auth, and API routes.
- `src/features/health/*`: health monitoring and health endpoints.
- `src/features/status/*`: operational status endpoints.
- `src/features/updates/*`: installed-version detection and release-check endpoints for the Updates screen.
- `src/lib/*`: shared helpers such as logging, HTML escaping, and secret masking.
- `frontend/src/*`: React application code.
- `release.json`: bundled suite release metadata copied into the Suite Manager runtime image so installed-version reporting still works when the repo root is not present in the container.
- `branding/styles/mos.css`: canonical MOS brand stylesheet source, synchronized into app-local copies by `npm run branding:sync`.

#### Local development

- Backend only: `npm start`
- Frontend dev server: `npm run dev:client`
- Frontend production build: `npm run build:client`
- Release metadata sanity check from repo root: `npm run release:check`

#### Customizations in this project

- Acts as the shared onboarding surface for stack-wide bootstrap, credential handoff, and future per-app provisioning adapters.
- Acts as the authenticated public entrypoint for setup and Homepage access.
- Treats Vaultwarden account creation as observed suite state, not a user-confirmed checklist item.
- Keeps the current onboarding surface intentionally narrow: one guided access flow first, with later app-specific onboarding still to come.
