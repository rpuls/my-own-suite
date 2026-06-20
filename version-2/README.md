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
npm --prefix version-2 run branding:sync
```

## First Slice

Build and validate the control plane before optional apps:

- Install Suite Manager, Homepage, Caddy, and required host agents.
- Do not require owner email or password in the installer.
- Let the owner create the MOS account in Suite Manager on first browser visit.
- Rebuild or copy only the Suite Manager UI primitives needed for the first-run screen.
- Reuse the DigitalOcean smoke harness for real install validation once the no-owner path exists.

## Authenticated Control-Plane Routes

V2 uses one public origin while keeping Homepage private:

- `home.<domain>` is the only public control-plane host.
- Suite Manager serves onboarding, login, account controls, UI, and API under `/suite-manager/`.
- Every other authenticated path is proxied by Suite Manager to Homepage.
- Caddy sends the Home host to Suite Manager. It never routes public traffic directly to Homepage.
- Homepage listens only on `127.0.0.1:3200`, and Suite Manager removes its session cookie before forwarding requests upstream.

The session remains host-only but now covers both dashboard and Suite Manager because they share one origin. Future apps can keep their own authentication without receiving the MOS control-plane cookie.

## Installer Foundation

V2 installer front doors share one bootstrap contract under `scripts/installers/`. The contract requires no `.env` file for the first boot. Repository URL/ref and domain can be supplied, but default to the MOS GitHub repo, `feat/app-platform-v2-lab`, and either `<public-ip>.sslip.io` for smoke/cloud paths or `localhost` for local render checks.

Render the current bootstrap shape from the repo root:

```powershell
npm --prefix version-2 run install:render -- --target json
npm --prefix version-2 run install:render -- --target cloud-init --public-ipv4 203.0.113.42
npm --prefix version-2 run install:render -- --target ssh
npm --prefix version-2 run install:render -- --target usb
```

The V2 DigitalOcean smoke script can create a fresh Droplet and install the V2 control plane:

```powershell
npm --prefix version-2 run smoke:do:up
npm --prefix version-2 run smoke:do:reset
npm --prefix version-2 run smoke:do:destroy
npm --prefix version-2 run smoke:do:render
```

`smoke:do:up` is the paid, user-run path. It creates a tagged DigitalOcean Droplet, installs the V2 Caddy, Suite Manager, and private Homepage control plane from the selected repo/ref, waits for `/suite-manager/api/setup/status`, and prints the Home and Suite Manager paths. `smoke:do:render` remains the free dry-run path.

## Test Command

From the repo root:

```powershell
npm --prefix version-2 test
```

This syncs branding and verifies the V2 Suite Manager backend contract without starting Docker, touching host agents, importing the old Suite Manager app, or changing the current stack.

## Suite Manager Frontend

The first V2 Suite Manager UI is a small React + Vite app under `suite-manager/frontend/`.

From the repo root:

```powershell
npm --prefix version-2 run dev:client
npm --prefix version-2 run build:client
```

The backend serves the built frontend from `suite-manager/frontend/dist/` under `/suite-manager/`, with static assets reserved under `/suite-manager/assets/`. The app covers owner first-run setup, login, logout, the initial control-plane screen, and the authentication boundary in front of Homepage.

## Reference Material

- `staging`: integration base for this branch.
- `feat/app-catalog-provisioning`: prototype reference for app catalog and package-projection lessons.
- `apps/suite-manager/`: old Suite Manager implementation and design inspiration.
- `scripts/smoke/digitalocean.cjs`: existing DigitalOcean smoke harness to adapt when V2 has an install path.

Do not merge the prototype branch wholesale into this workspace.
