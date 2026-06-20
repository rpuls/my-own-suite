# V2 Suite Manager

Suite Manager is the V2 control-plane app.

It owns the web UI, backend API, first-run owner setup, platform state, app lifecycle orchestration, and communication with system agents.

It should not import the old Suite Manager runtime from `apps/suite-manager/`.

## Frontend

The V2 Suite Manager frontend starts as a small React + Vite app under `frontend/`.

The first app surface is intentionally narrow:

- first-run owner account creation
- existing-owner login
- logout
- a signed-in control-plane placeholder
- authenticated access to the private Homepage dashboard

The old Suite Manager frontend is useful reference material for the shell shape, feature-folder layout, and shared UI style, but V2 must rebuild only the pieces it needs under `version-2/`.

Useful commands from the repo root:

```powershell
npm --prefix version-2 run dev:client
npm --prefix version-2 run build:client
cmd /c npm --prefix version-2 test
```

## Persistence

SQLite is Suite Manager's durable source of truth. The database is `suite-manager.sqlite` under the configurable `MOS_V2_STATE_DIR`; installed control planes use `/var/lib/mos-v2/suite-manager/suite-manager.sqlite`, while local development defaults to `.state/suite-manager.sqlite` relative to the working directory.

The backend uses the Node 22 built-in `node:sqlite` module, enables foreign keys, a five-second busy timeout, and WAL journaling, and applies ordered schema migrations recorded in `schema_migrations`. SQL stays inside the domain-oriented Suite Manager store. Owner creation and its initial session are committed in one transaction, the schema permits only owner ID `1`, passwords remain scrypt hashes, and only SHA-256 session-token hashes are stored.

### Legacy JSON import

On startup, Suite Manager imports `platform-state.json` only when `suite-manager.sqlite` does not already exist. The validated owner and hashed sessions are imported in one transaction, then the JSON file is renamed to `platform-state.json.migrated`. Import failure removes the newly created database so the next start can retry safely. If SQLite already exists, it always wins and the JSON file is left untouched; Suite Manager never overwrites initialized SQLite state.

Back up the database with a SQLite-aware backup tool or while Suite Manager is stopped so the database and WAL state remain consistent. Do not edit the database or migration records manually.

## Homepage Authentication Boundary

Suite Manager accepts only the configured `home.<domain>` host and rejects unknown hosts. It owns `/suite-manager/` for onboarding, login, account controls, static assets, and API routes. All other requests require a valid `mos_v2_session` before they are streamed to `MOS_V2_HOMEPAGE_UPSTREAM`.

The proxy preserves request paths, query strings, request/response streaming, redirects, forwarded origin information, and WebSocket upgrades. It removes the MOS cookie before contacting Homepage and ignores upstream cookies. Unauthenticated browser traffic is redirected to `/suite-manager/`, unauthenticated upgrades are rejected, and an unavailable upstream returns `502`.

The cookie remains host-only. Because dashboard and Suite Manager share the Home origin, one login covers both without sharing MOS credentials with future app subdomains.
