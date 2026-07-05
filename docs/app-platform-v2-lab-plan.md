# App Platform V2 Lab Plan

Temporary branch master plan for `feat/app-platform-v2-lab`. Keep this document compact enough to load in a fresh Codex session. Durable architecture belongs in [decisions.md](./decisions.md); task-level follow-up should move to GitHub Issues before this branch merges.

## Current State

MOS V2 lives under `version-2/` as a clean-slate launch platform. The old root `apps/`, `scripts/`, `deploy/`, and `agents/` trees are reference material unless a feature is deliberately rebuilt into V2.

Verified foundation:

- Browser-created owner account, auth sessions, and SQLite persistence.
- One authenticated `home.<domain>` origin: Suite Manager at `/suite-manager/`, private Homepage at `/`.
- Homepage customization with revision-aware YAML editing, guided links/home services, transactional agent apply, and generated Caddy/Homepage projections.
- Post-install Cloudflare DNS-01 HTTPS through a narrow root HTTPS agent.
- DigitalOcean and Hyper-V smoke paths for realistic cloud and USB-style validation.
- App Catalog UX with search, standalone/companion grouping, detail-first install flow, setup fields, install progress, status, advanced details, Homepage shortcut choice only for packages that declare Homepage metadata, and post-install setup guides.

Verified app package capabilities:

- Self-contained packages under `version-2/apps/<app-id>/`.
- Manifest validation for metadata, setup fields, package role, resources, routes, optional Homepage entries/widgets, health checks, catalog presentation, and onboarding metadata.
- Generated and user-supplied setup values with secret redaction.
- SQLite app instance/config/projection/operation state.
- Narrow app agent for Docker/Caddy/health work instead of broad Suite Manager host privileges.
- Runtime health refresh, disable, re-enable, restart, and uninstall-with-data-preserved.
- Multi-service package apply/remove for Seafile core.
- Capability-based app-to-app integration, proven by ONLYOFFICE plus Seafile, with relationship recovery/status hooks around restart, re-enable, disable, and preserved-data uninstall.

Current packages:

- `stirling-pdf`: first intentionally boring single-service app.
- `vaultwarden`: generated secret and persisted config pressure test.
- `radicale`: V1-era calendar/contact sync app with user-supplied setup, setup guide, and Homepage calendar widget.
- `seafile`: first serious multi-service app package with internal database/cache and one public route.
- `onlyoffice`: independent document-editor capability provider connected to Seafile through the first generic relationship flow, presented as a companion app without a normal Homepage shortcut.

## Durable Conclusions

- V2 is a control-plane-first platform, not a preloaded suite. Fresh installs should bootstrap Suite Manager, Homepage, Caddy, and agents; users select apps later.
- Package-specific behavior belongs in `version-2/apps/<app-id>/`. Suite Manager core and agents operate on generic manifests, projections, lifecycle state, and capability metadata.
- Generated runtime outputs should be reproducible from package manifests plus persisted instance/relationship state.
- Secrets must remain out of public APIs, logs, projections, and broad SQLite state. Raw secret material is materialized only at narrow runtime apply boundaries.
- Homepage routes and app package routes stay separate: Homepage customization owns user dashboard/home-service routes; app packages own lifecycle-managed app routes.
- Post-install setup guides are declarative and app-scoped, not global owner onboarding.
- ONLYOFFICE should be its own package that provides a document-editor capability. Seafile is one compatible consumer, not the parent package. Future file/content platforms should be able to consume the same capability through generic metadata. Capability providers and companion apps do not need normal Homepage contributions.

## Next Slice

Before adding more heavy apps, validate the hardened capability/integration path:

1. Validate Seafile core and ONLYOFFICE integration in Hyper-V, including install order, app health, document editing connection, provider restart recovery, disable/re-enable, and preserved-data uninstall.
2. Confirm relationship state remains truthful when either side is stopped, disabled, re-enabled, or uninstalled with data preserved.
3. Inspect integration failure recovery diagnostics in live runtime logs/API responses without leaking JWT or other secret material.
4. Decide the next single follow-up:
   - deeper integration lifecycle diagnostics if Hyper-V exposes issues,
   - backup/restore metadata for installed app data,
   - or the next V1 app package once Seafile/ONLYOFFICE is operationally proven.

Do not start `/site`, Railway alignment, public documentation migration, or broad catalog growth until the V2 app engine is proven enough.

## V2 Workspace Map

```text
version-2/
  suite-manager/      # Web UI, backend API, auth, state, package orchestration.
  apps/               # Self-contained app packages.
  system-agents/      # Narrow privileged host agents.
  infrastructure/     # Caddy, Homepage, runtime templates/projections.
  scripts/            # Installers, smoke harnesses, operator/dev commands.
  branding/           # Canonical V2 brand assets and CSS tokens.
  site/               # Future landing/docs site; intentionally not active yet.
  tests/              # V2-owned Playwright harness.
  test/               # Node contract/unit tests.
```

## Validation Rules

- Local deterministic command: `cmd /c npm --prefix version-2 test`.
- Run `cmd /c npm --prefix version-2 run typecheck` and `cmd /c npm --prefix version-2 run build:client` when frontend/types change.
- Do not run paid DigitalOcean smoke automatically.
- Do not run noisy Playwright/E2E automatically; ask the user to run it and paste relevant output.
- Do not reset/destroy Hyper-V automatically unless the user asks or confirms.
- Use Hyper-V for live tamper validation of host-state behavior: stop containers, restart agents, inspect Caddy snippets, verify status recovery, and preserve volumes/secrets.

## Remaining Known Gaps

- Secret storage is hardened for current use but still not a final long-term secret subsystem. Remaining decisions include rotation, reveal policy, backup/restore behavior, and missing-secret recovery.
- Preserved-data uninstall needs a later cleanup/reinstall story so users can intentionally delete abandoned volumes/secrets without accidents.
- App backup/restore semantics are not yet modeled for V2 packages. Temporary research lives in [v2-backup-restore-design.md](./v2-backup-restore-design.md); the next recommended slice is a V2 backup inventory/dry-run endpoint before archive or restore implementation.
- Integration relationships now have deterministic lifecycle coverage, but still need live Hyper-V validation before adding many provider/consumer pairs.
- Public `/site` docs and Railway/platform alignment are intentionally deferred.

## Merge Cleanup

Before this branch merges:

- Convert remaining task state into GitHub Issues.
- Keep durable architecture only in [decisions.md](./decisions.md).
- Delete or replace this temporary plan with issue/decision pointers.
