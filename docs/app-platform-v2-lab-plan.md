# MOS2 Cutover Note

MOS2 is no longer isolated under `version-2/`. It is the default repository layout.

The old MOS1 root shape was snapshotted to `archive/mos1-main-snapshot` before the cutover. The old public site source is retained as `site-mos1-reference/` for reference while the MOS2 public site/docs are rebuilt later.

## Active Root Map

```text
suite-manager/      # Web UI, backend API, auth, state, package orchestration.
apps/               # Self-contained app packages.
system-agents/      # Narrow privileged host agents.
infrastructure/     # Caddy, Homepage, installer, runtime templates/projections.
scripts/            # Installers, smoke harnesses, operator/dev commands.
branding/           # Canonical MOS2 brand assets and CSS tokens.
shared/             # Cross-process contracts.
site/               # Future MOS2 public site placeholder.
site-mos1-reference/# Preserved MOS1 public site source.
test/unit/          # Node contract/unit tests.
test/e2e/           # Browser and Hyper-V E2E harnesses.
```

## Validation Rules

- Local deterministic command: `cmd /c npm test`.
- Run `cmd /c npm run typecheck` and `cmd /c npm run build:client` when frontend/types change.
- Do not run paid DigitalOcean smoke automatically.
- Do not run noisy Playwright/E2E automatically; ask the user to run it and paste relevant output.
- Do not reset/destroy Hyper-V automatically unless the user asks or confirms.

## Deferred

- Public landing page rewrite.
- Full `/site` docs rebuild.
- Release metadata cleanup beyond keeping current release files intact.
- Any MOS1 migration guide, if it becomes useful later.
