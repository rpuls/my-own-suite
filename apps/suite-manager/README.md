#### Environment variables

- `PORT`: HTTP port for the suite-manager status endpoint. Defaults to `3000`.
- `HOMEPAGE_URL`: Homepage URL to probe. Defaults to `http://homepage:3000/`.
- `SUITE_MANAGER_CHECK_INTERVAL_MS`: Homepage probe interval in milliseconds. Defaults to `300000`.
- `SUITE_MANAGER_REQUEST_TIMEOUT_MS`: Timeout per Homepage request in milliseconds. Defaults to `10000`.
- `SUITE_MANAGER_RUN_ONCE`: If set to `true`, performs one Homepage check and exits. Useful for smoke tests.
- `OWNER_NAME`: Display name shown in the onboarding flow.
- `OWNER_EMAIL`: Shared owner email shown in onboarding and reused by compatible app bootstrap flows.
- `BOOTSTRAP_TOKEN`: Optional token used to unlock protected onboarding actions such as credential handoff artifacts.
- `SUITE_MANAGER_PUBLIC_URL`: Public onboarding URL surfaced in the UI.
- `SUITE_MANAGER_STATE_DIR`: Directory used to persist onboarding progress.
- `VAULTWARDEN_DATABASE_URL` or `DATABASE_URL`: Optional Postgres connection string used to detect when the owner Vaultwarden account has been created. In the VPS/local stack, this is sourced from the existing Vaultwarden service env.
- `SEAFILE_ADMIN_EMAIL`, `SEAFILE_ADMIN_PASSWORD`, `RADICALE_ADMIN_USERNAME`, `RADICALE_ADMIN_PASSWORD`: Consumed from existing service env files so suite-manager can prepare the first Vaultwarden import handoff.
- `DOMAIN` / `PUBLIC_URL_SCHEME`: Optional fallback inputs for deriving public app URLs when explicit `*_PUBLIC_URL` values are not set.

#### Health and behavior

- Serves a React/Vite onboarding frontend on `/`.
- Exposes a simple HTTP `200` health endpoint on `/healthz`.
- Exposes JSON status and onboarding data on `/api/status` and `/api/onboarding`.
- Logs a success line when Homepage returns a `2xx` response.
- Logs a failure line when Homepage returns a non-`2xx` response or the request errors.
- Persists onboarding step completion in `SUITE_MANAGER_STATE_DIR`.
- Automatically advances past Vaultwarden account creation when the configured Vaultwarden database shows a user matching `OWNER_EMAIL`.
- Serves a Vaultwarden-compatible CSV import artifact for the generated accounts currently available to suite-manager, and the frontend can copy that content directly to the clipboard for paste-based import.

#### Development structure

- Uses `Hono` for the backend API and service runtime.
- Uses `React` + `Vite` for the frontend onboarding app.
- `src/index.ts`: process entrypoint and lifecycle wiring.
- `src/app.ts`: top-level route registration.
- `src/config.ts`: environment parsing and public URL derivation.
- `src/features/onboarding/*`: onboarding state, domain model, auth, and API routes.
- `src/features/health/*`: health monitoring and health endpoints.
- `src/features/status/*`: operational status endpoints.
- `src/lib/*`: shared helpers such as logging, HTML escaping, and secret masking.
- `frontend/src/*`: React application code.
- `frontend/src/styles/mos.css`: shared MOS brand stylesheet imported by both `suite-manager` and the Astro site.

#### Local development

- Backend only: `npm start`
- Frontend dev server: `npm run dev:client`
- Frontend production build: `npm run build:client`

#### Customizations in this project

- Acts as the shared onboarding surface for stack-wide bootstrap, credential handoff, and future per-app provisioning adapters.
- Treats Vaultwarden account creation as observed suite state, not a user-confirmed checklist item.
- Keeps the current onboarding surface intentionally narrow: one guided access flow first, with later app-specific onboarding still to come.
