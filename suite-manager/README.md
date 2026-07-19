# V2 Suite Manager

Suite Manager is the V2 control-plane app.

It owns the web UI, backend API, first-run owner setup, platform state, app lifecycle orchestration, and communication with system agents.

It is self-contained and does not import archived control-plane code.

## Frontend

The V2 Suite Manager frontend starts as a small React + Vite app under `frontend/`.

The first app surface is intentionally narrow:

- first-run owner account creation
- existing-owner login
- logout
- responsive Dashboard, Customize, Settings, and sign-out navigation
- Cloudflare DNS-01 HTTPS configuration
- authenticated access to the private Homepage dashboard

The active control-plane code lives in this root-level `suite-manager/` tree; historical implementations remain isolated in the archive branch.

Useful commands from the repo root:

```powershell
cmd /c npm run dev
cmd /c npm test
```

`dev` builds the frontend, starts the backend, and serves Suite Manager at `http://home.localhost:3100/suite-manager/`. Use `home.localhost`, not `127.0.0.1`, because the local backend validates the configured Home host.

## Persistence

SQLite is Suite Manager's durable source of truth. The database is `suite-manager.sqlite` under the configurable `MOS_V2_STATE_DIR`; installed control planes use `/var/lib/mos-v2/suite-manager/suite-manager.sqlite`, while local development defaults to `.state/suite-manager.sqlite` relative to the working directory.

The `https-settings` migration stores only non-secret configuration and status: active/pending base domain, TLS mode, ACME email, provider, timestamps, and sanitized apply outcome. The Cloudflare token is never stored in SQLite or returned by an API. Pending fields keep a candidate host allowlisted during apply without replacing a previously working configuration.

The backend uses the Node 22 built-in `node:sqlite` module, enables foreign keys, a five-second busy timeout, and WAL journaling, and applies ordered schema migrations recorded in `schema_migrations`. SQL stays inside the domain-oriented Suite Manager store. Owner creation and its initial session are committed in one transaction, the schema permits only owner ID `1`, passwords remain scrypt hashes, and only SHA-256 session-token hashes are stored.

Owner login uses bounded in-memory progressive throttling. A per-client-address limit slows concentrated guessing, while a looser account-wide limit catches attempts distributed across addresses without creating a permanent owner lockout. Entries expire automatically, successful login clears the applicable backoff, and account identifiers are hashed in limiter memory. Suite Manager accepts `X-Forwarded-For` for this purpose only when the direct peer is the loopback Caddy proxy.

Throttle events are persisted without raw addresses or account identifiers. SQLite stores one aggregate per UTC hour, event type, and pseudonymous client fingerprint, including only the count, maximum retry delay, and first/last timestamps. Writes enforce 30-day retention and a 5,000-row hard cap, and persistence failure never bypasses or breaks the in-memory throttle. This bounded event history is intended for a future authenticated security summary rather than a raw request log.

### Legacy JSON import

On startup, Suite Manager imports `platform-state.json` only when `suite-manager.sqlite` does not already exist. The validated owner and hashed sessions are imported in one transaction, then the JSON file is renamed to `platform-state.json.migrated`. Import failure removes the newly created database so the next start can retry safely. If SQLite already exists, it always wins and the JSON file is left untouched; Suite Manager never overwrites initialized SQLite state.

Back up the database with a SQLite-aware backup tool or while Suite Manager is stopped so the database and WAL state remain consistent. Do not edit the database or migration records manually.

## HTTPS Settings Boundary

Authenticated owners use `/suite-manager/settings`. Suite Manager validates the exact three-field request and sends it over a restricted Unix socket to the V2 HTTPS agent. Successful configuration reports `https://home.<base-domain>/`; because sessions are host-only, the owner signs in again on that new origin.

The original installer-created HTTP Home host remains an authenticated recovery URL. The configured HTTP host redirects to HTTPS. Suite Manager accepts only the bootstrap host plus pending or active Home hosts from SQLite, trusts forwarded protocol at its loopback deployment boundary, and marks session cookies `Secure` on HTTPS.

Cloud-init installs additionally require HTTPS and an installer-generated one-time claim secret before the first owner can be created. If a provider-level firewall blocks public certificate issuance or HTTPS reachability, the HTTP origin exposes only setup diagnostics and never accepts owner credentials.

## Homepage Authentication Boundary

Suite Manager accepts only the configured `home.<domain>` host and rejects unknown hosts. It owns `/suite-manager/` for onboarding, login, account controls, static assets, and API routes. All other requests require a valid `mos_v2_session` before they are streamed to `MOS_V2_HOMEPAGE_UPSTREAM`.

The proxy preserves request paths, query strings, request/response streaming, redirects, forwarded origin information, and WebSocket upgrades. It removes the MOS cookie before contacting Homepage and ignores upstream cookies. Homepage receives the stable bootstrap host for its private allowlist while `X-Forwarded-Host` retains the browser origin. Unauthenticated browser traffic is redirected to `/suite-manager/`, unauthenticated upgrades are rejected, and an unavailable upstream returns `502`.

The cookie remains host-only. Because dashboard and Suite Manager share the Home origin, one login covers both without sharing MOS credentials with future app subdomains.

## Homepage Customization Boundary

Authenticated owners use `/suite-manager/customize` to edit only `bookmarks.yaml`, `services.template.yaml`, `settings.yaml`, and `widgets.yaml`. Reads return a content revision; saves require that revision and validate through the structured YAML parser before the narrow Homepage agent writes anything. Guided links remain dashboard-only. Guided home services accept only name, description, icon, group, HTTP/HTTPS upstream host and port, and public subdomain; they store stable user-managed metadata without credentials or arbitrary Caddy text.

Customize follows the established MOS Homepage workflow: an always-visible file list, a syntax-aware YAML editor, explicit validation before save/apply, reload protection for dirty content, and a shared two-step Add-to-Homepage dialog. The home-network helper derives protocol, host, port, and a friendly subdomain from the address users already know, then previews the V2-owned public route before applying the same structured agent request.

SQLite records owner, operation, revision, app installation/configuration, package identity, integration, and guide state. Durable Homepage files remain the dashboard source and `services.yaml` is generated; package snapshots and narrow host agents own runtime, volume, backup, and lifecycle boundaries.

Homepage apply may include a bounded service restart. The Homepage agent allows 60 seconds for that host operation and Suite Manager allows 75 seconds for the agent response. Suite Manager orders startup after Homepage and wants the service available, but is not stopped when Homepage restarts, so the authenticated apply request can complete normally.
