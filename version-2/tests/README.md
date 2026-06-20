# V2 Tests

Fast backend, migration, renderer, agent, and contract tests run with:

```powershell
cmd /c npm --prefix version-2 test
```

The V2 Playwright harness under `e2e/` builds the real frontend, starts Suite Manager with isolated temporary SQLite state, runs the pinned Homepage container on a private loopback port, and starts a test-owned local adapter behind the real Homepage agent contract. It has no auth bypasses or production-only test routes.

Install Chromium once, then run local E2E explicitly:

```powershell
cmd /c npm --prefix version-2 run e2e:install
cmd /c npm --prefix version-2 run e2e:local
cmd /c npm --prefix version-2 run e2e:local:headed
```

Local E2E covers owner setup, Customize navigation, invalid YAML, allowlisted editing, guided link/home-service apply, Homepage tile rendering, Settings validation, sign-out, and signed-out protection. It deliberately runs without privileged systemd/Caddy writes, Cloudflare, or DigitalOcean. Real Homepage-agent and DNS-01 validation is separate and documented in `scripts/README.md`.
