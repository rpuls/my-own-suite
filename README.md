# My Own Suite

My Own Suite is a self-hosted control plane for installing and managing private open-source apps from one owner UI.

MOS2 is now the default repo layout. The old MOS1 root shape is preserved on the `archive/mos1-main-snapshot` branch, and the old public site source remains in `site-mos1-reference/` for reference while the MOS2 public docs are rebuilt later.

## Current Shape

| Path | Purpose |
| --- | --- |
| `suite-manager/` | MOS2 web UI, backend API, owner setup, app catalog, settings, backups, and updates. |
| `apps/` | Self-contained MOS2 app packages with manifests, Dockerfiles, icons, setup guides, and technical notes. |
| `system-agents/` | Narrow host-owned agents for app runtime, Homepage, HTTPS, backups, updates, and lab reset. |
| `infrastructure/` | Shared runtime substrate for Caddy, Homepage defaults, installer support, and control-plane contracts. |
| `scripts/` | MOS2 installer renderers, smoke harnesses, reconciliation, branding sync, and developer commands. |
| `shared/` | Cross-process contracts used by Suite Manager and host agents. |
| `test/` | Deterministic unit tests and browser/E2E harnesses. |
| `site/` | Future MOS2 public site placeholder. |
| `site-mos1-reference/` | Preserved MOS1 public site source for reference only. |

## Local Development

Install dependencies, build the Suite Manager frontend, and run the local control plane:

```bash
npm install
npm run dev
```

Open `http://home.localhost:3100/suite-manager/`.

Useful deterministic commands:

```bash
npm test
npm run typecheck
npm run build:client
npm run install:render -- --target json
```

Browser and infrastructure smoke commands are intentionally human-run because they are noisy or can create paid/destructive resources. See [scripts/README.md](./scripts/README.md) and [test/README.md](./test/README.md).

## Documentation Map

| Need | Go here |
| --- | --- |
| Documentation ownership | [docs/README.md](./docs/README.md) |
| Architecture decisions | [docs/decisions.md](./docs/decisions.md) |
| Release process | [RELEASING.md](./RELEASING.md) |
| Release notes | [CHANGELOG.md](./CHANGELOG.md) |
| Suite Manager technical notes | [suite-manager/README.md](./suite-manager/README.md) |
| App package technical notes | `apps/<app>/README.md` |
| Host-agent notes | [system-agents/README.md](./system-agents/README.md) |
| Operator/developer scripts | [scripts/README.md](./scripts/README.md) |
| Test harness notes | [test/README.md](./test/README.md) |

For day-to-day prototyping, use `staging` as the integration branch and reserve `main` for stable release-ready batches.
