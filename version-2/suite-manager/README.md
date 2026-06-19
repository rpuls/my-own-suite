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

The old Suite Manager frontend is useful reference material for the shell shape, feature-folder layout, and shared UI style, but V2 must rebuild only the pieces it needs under `version-2/`.

Useful commands from the repo root:

```powershell
npm --prefix version-2 run dev:client
npm --prefix version-2 run build:client
cmd /c npm --prefix version-2 test
```

## Persistence

The first owner-onboarding slice uses the V2-local versioned JSON store at `platform-state.json` for owner metadata and sessions.

This is milestone persistence only. Before V2 adds richer settings, more user details, app install state, migrations, or longer-lived session policy, Suite Manager should move to a local SQLite database owned by Suite Manager. SQLite gives V2 a small self-host-friendly persistence layer with transactions, indexes, migrations, and queryable state without requiring a separate database service for the control plane.
