# Version 2.0

This folder is the clean-slate home for the MOS V2 launch platform.

Everything outside `version-2/` is the existing system. It is useful reference material, but V2 should not run through it by default. When old code contains a good idea, copy or rebuild the specific idea into this folder deliberately.

The active roadmap and session checklist lives in `docs/app-platform-v2-lab-plan.md`.

## Workspace Layout

- `suite-manager/`: the V2 control-plane app. It owns the web UI, backend API, owner setup, app install orchestration, and communication with system agents.
- `site/`: future V2 public landing/docs site. Do not start this until the platform direction is steadier.
- `apps/`: future app packages. Each app should live in its own folder with manifest, runtime assets, setup helpers, Dockerfiles, and app-specific docs.
- `scripts/`: V2 operator/development scripts, including future DigitalOcean smoke wrappers and installer entry points.
- `system-agents/`: host-side agents for narrow privileged actions such as updates, backups, service apply, and restore.
- `infrastructure/`: shared runtime substrate that is not owned by one app, such as Caddy base config, Compose assembly/templates, Docker build conventions, and generated-output contracts.
- `branding/`: canonical V2 brand source for shared colors, fonts, marks, favicons, and CSS tokens.

App-owned Dockerfiles should live under `apps/<app>/`. Shared Compose/Caddy templates and projection contracts should live under `infrastructure/`. Suite Manager should orchestrate app install state, but host-level apply work should go through `system-agents/`.

Shared color/style changes start in `branding/styles/mos.css`, then sync to the future site, Suite Manager, and Homepage targets:

```powershell
cmd /c npm --prefix version-2 run branding:sync
```

## First Slice

Build and validate the control plane before optional apps:

- Install Suite Manager, Homepage, Caddy, and separate narrow HTTPS/Homepage host agents.
- Do not require owner email or password in the installer.
- Let the owner create the MOS account in Suite Manager on first browser visit.
- Rebuild or copy only the Suite Manager UI primitives needed for the first-run screen.
- Reuse the DigitalOcean smoke harness for real install validation once the no-owner path exists.
- Configure real HTTPS after installation through responsive Suite Manager navigation and Settings, migrated non-secret state, a narrow root agent, and repo-built Cloudflare-capable Caddy.

## Authenticated Control-Plane Routes

V2 uses one public origin while keeping Homepage private:

- `home.<domain>` is the only public control-plane host.
- Suite Manager serves onboarding, login, account controls, UI, and API under `/suite-manager/`.
- Every other authenticated path is proxied by Suite Manager to Homepage.
- Caddy sends the Home host to Suite Manager. It never routes public traffic directly to Homepage.
- Homepage listens only on `127.0.0.1:3200`, and Suite Manager removes its session cookie before forwarding requests upstream.

The session remains host-only but now covers both dashboard and Suite Manager because they share one origin. Future apps can keep their own authentication without receiving the MOS control-plane cookie.

## Durable Suite Manager State

Suite Manager stores owner identity and sessions in `suite-manager.sqlite` under `MOS_V2_STATE_DIR`. The installed runtime sets that directory to `/var/lib/mos-v2/suite-manager`; local runs default to `.state`. Schema changes are ordered migrations, owner creation plus its initial session is transactional, and password/session secrets are stored only as hashes. Existing prototype `platform-state.json` state is imported once only when no SQLite database exists and retained as `platform-state.json.migrated`.

See `suite-manager/README.md` for migration precedence and backup expectations.

## Installer Foundation

V2 installer front doors share one bootstrap contract under `scripts/installers/`. The contract requires no `.env` file for the first boot. Repository URL/ref and domain can be supplied, but default to the MOS GitHub repo, `feat/app-platform-v2-lab`, and either `<public-ip>.sslip.io` for smoke/cloud paths or `localhost` for local render checks.

Render the current bootstrap shape from the repo root:

```powershell
cmd /c npm --prefix version-2 run install:render -- --target json
cmd /c npm --prefix version-2 run install:render -- --target cloud-init --public-ipv4 203.0.113.42
cmd /c npm --prefix version-2 run install:render -- --target ssh
cmd /c npm --prefix version-2 run install:render -- --target usb
```

The V2 DigitalOcean smoke script can create a fresh Droplet and install the V2 control plane:

```powershell
cmd /c npm --prefix version-2 run smoke:do:reset
cmd /c npm --prefix version-2 run smoke:do:destroy
cmd /c npm --prefix version-2 run smoke:do:render
```

`smoke:do:reset` is the paid, user-run path. It creates or replaces a tagged DigitalOcean Droplet, installs the V2 Caddy, Suite Manager, and private Homepage control plane from the selected repo/ref, waits for `/suite-manager/api/setup/status`, and prints the Home and Suite Manager paths. `smoke:do:render` remains the free dry-run path.

## Test Command

From the repo root:

```powershell
cmd /c npm --prefix version-2 test
```

This syncs branding and verifies the V2 Suite Manager, SQLite, HTTPS agent, Caddy renderer, installer, and platform contracts without starting Docker, touching installed host services, importing the old Suite Manager app, or changing the current stack.

Browser E2E is deliberately user-run:

```powershell
cmd /c npm --prefix version-2 run e2e:local
cmd /c npm --prefix version-2 run e2e:local:headed
```

## Suite Manager Frontend

The first V2 Suite Manager UI is a small React + Vite app under `suite-manager/frontend/`.

From the repo root:

```powershell
cmd /c npm --prefix version-2 run dev
```

Open `http://home.localhost:3100/suite-manager/`. The backend rejects `127.0.0.1` by default because V2 validates the configured Home host.

The local command builds the frontend, then starts the backend that serves `suite-manager/frontend/dist/` under `/suite-manager/`, with static assets reserved under `/suite-manager/assets/`. The app covers owner first-run setup, login, responsive Dashboard/Customize/Settings/sign-out navigation, post-install HTTPS setup, revision-aware Homepage YAML editing, guided dashboard links/home services, and the authentication boundary in front of Homepage.

SQLite owns platform, operation, and revision metadata. Durable Homepage YAML owns dashboard layout and user-managed network-service presentation; `services.template.yaml` is editable and `services.yaml` plus the MOS Caddy route snippet are generated projections. Future app packages remain responsible for installation inputs, secrets, dependencies, volumes, provisioning, backup, and lifecycle.

## Reference Material

- `staging`: integration base for this branch.
- `feat/app-catalog-provisioning`: prototype reference for app catalog and package-projection lessons.
- `apps/suite-manager/`: old Suite Manager implementation and design inspiration.
- `scripts/smoke/digitalocean.cjs`: existing DigitalOcean smoke harness to adapt when V2 has an install path.

Do not merge the prototype branch wholesale into this workspace.
