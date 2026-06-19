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

The backend serves the built frontend from `suite-manager/frontend/dist/`. The app currently covers only owner first-run setup, login, logout, and a signed-in control-plane placeholder.

## Reference Material

- `staging`: integration base for this branch.
- `feat/app-catalog-provisioning`: prototype reference for app catalog and package-projection lessons.
- `apps/suite-manager/`: old Suite Manager implementation and design inspiration.
- `scripts/smoke/digitalocean.cjs`: existing DigitalOcean smoke harness to adapt when V2 has an install path.

Do not merge the prototype branch wholesale into this workspace.
