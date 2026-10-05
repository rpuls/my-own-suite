# MOS Tests

Fast backend, migration, renderer, agent, and contract tests run with:

```powershell
cmd /c npm test
```

The MOS Playwright harness under `e2e/` builds the real frontend, starts Suite Manager with isolated temporary SQLite state, runs the pinned Homepage container on a private loopback port, and starts a test-owned local adapter behind the real Homepage agent contract. It has no auth bypasses or production-only test routes.

Install Chromium once, then run local E2E explicitly:

```powershell
cmd /c npm run e2e:install
cmd /c npm run e2e:local
cmd /c npm run e2e:local:headed
```

Local E2E covers owner setup, Customize navigation, invalid YAML, allowlisted editing, guided link/home-service apply, Homepage tile rendering, Settings validation, sign-out, and signed-out protection. It deliberately runs without privileged systemd/Caddy writes, Cloudflare, or DigitalOcean. Real Homepage-agent and DNS-01 validation is separate and documented in `scripts/README.md`.

## Lab E2E: steps, paths and app modules

The lab suite runs against a real, already-running MOS install, normally the Hyper-V lab. It never creates or destroys the VM. Start or reset the lab yourself first and wait for Suite Manager readiness. After a host PC restart, run `npm run smoke:hyperv:refresh` (Administrator terminal) first: the Default Switch subnet changes on every host boot, so the lab is unreachable until the guest IP and hosts entries are refreshed (details in `scripts/README.md`).

A run is a **path**: a sequence of **steps**, each a core module in `test/e2e/modules/` or an app's own module in `apps/<id>/e2e/`. Named paths are shorthand for common sequences, and steps can be added to them or used alone:

```powershell
cmd /c npm run e2e -- @full                       # the whole platform with every catalog app
cmd /c npm run e2e -- @app-cycle <app>            # back up, install, use, restore, prove it is gone
cmd /c npm run e2e -- @app-dr <app>               # bucket backup, wiped lab, restore from the bucket
cmd /c npm run e2e -- @update <app>               # journey, platform + app update, check, before/after report
cmd /c npm run e2e -- @app-cycle --each-app       # one run per catalog app, then a matrix
cmd /c npm run e2e -- reset owner install:<app> app:<app> verify:<app>
cmd /c npm run e2e -- --list                      # every step and named path
cmd /c npm run e2e -- --dry-run @full             # the resolved steps, no browser
cmd /c npm run e2e:full                           # the same as `e2e -- @full`
```

- Steps that need HTTPS for an app whose manifest declares `requirements.https` get a `dns01` step in front of them automatically; `--dry-run` shows where.
- Each run writes `test/e2e/results/<run>/`: `summary.json` (every step, its duration and any error), `state.json` (what the apps' journeys made), app screenshots under `shots/`, the compare report under `compare/`, Playwright's trace, video and `error-context.md` under `playwright/`, and, when an app step fails, the app's own tabs as text under `failures/` (Playwright's error context shows only the suite's tab). The terminal shows one line per step and, on failure, the paths to all of these.
- `--continue <run>` carries an earlier run's app data and screenshots into a new run, so `verify:<app>` and `compare` work across runs: install and use an app, change the lab, then check it.
- `platform-update:wait` waits up to 40 minutes for the lab's update track to offer a new commit. The lab follows the branch it was installed from (`MOS_SMOKE_REPO_REF` at `smoke:hyperv:reset`), so pushing a commit to that branch while the step waits is how an update under test reaches the lab.

### App modules

Core test code names no app; a unit test enforces it. Everything particular to an app lives in its package at `apps/<id>/e2e/index.mjs`, whose default export is:

- `journey({ page, url, env, state, make, shot, step, freshPage })`: what an owner does in the app on a fresh install: sign in or register, create real data, and remember in `state` what `verify` will look for.
- `verify(...)`: that data is still there, after a restore, an update or a move to another domain.
- Optional: `landed({ page })` (the app's page has loaded), `setupValue({ field, env })` (a value for an install dialog field), `secrets({ env })` (values the diagnostics check must never find), `masks(page)` (regions to hide in screenshots), and `showcase` (which site screenshots the app volunteers for).
- `shot(name)` takes a named screenshot. The same name taken in a later step pairs with it in `compare`. `make.pdf()`, `make.png()` and `make.text()` draw test files at run time, so nothing binary is committed. `freshPage()` is a browser with nothing stored, as a new device would be. `connected` lists the app's own integration slots (from its manifest) that another installed app currently fills, so a journey can test working together without naming the other app.

A package's `e2e/` folder is never package content: it is not digested, copied into an installed app, or downloaded with a catalog update, so editing a test never changes the package version.

### Configuration

Create a local ignored config file before running:

```powershell
Copy-Item test\e2e\.env.example test\e2e\.env
```

- `MOS_E2E_BASE_URL`: the Home origin, for example `http://home.mos.hyperv`.
- `MOS_E2E_OWNER_EMAIL` and `MOS_E2E_OWNER_PASSWORD`: used to create the owner on a fresh install or sign in on an existing one.
- `MOS_E2E_DNS01_BASE_DOMAIN` and `CLOUDFLARE_API_TOKEN` (never commit it): the Cloudflare-managed domain the `dns01` step moves the suite to.
- App credentials have defaults in each app module and can be overridden with that module's own variables, such as `MOS_E2E_RADICALE_PASSWORD`.
- `backup:bucket` and `restore:bucket` use only the disposable lab bucket in the git-ignored `.local-tools/lab-bucket/bucket.env` (or the file named by `MOS_E2E_BUCKET_ENV`), each run in a folder of its own.

Before DNS-01 runs, Windows must resolve both the bootstrap hosts, such as `home.mos.hyperv`, and the post-DNS-01 hosts, such as `home.hyperv.diemernet.uk`, to the Hyper-V guest IP. `smoke:hyperv:reset` writes both sets into the marked hosts block and flushes DNS automatically. If you use another DNS-01 lab domain, set `MOS_HYPERV_EXTRA_HOST_DOMAINS` before reset or add equivalent local DNS/hosts entries yourself.

Site screenshots are captured best-effort by the `marketing` step and during installs into the ignored `test/e2e/screenshots/` folder, harvested by `npm run screenshots:update` (see `scripts/README.md`). A failed capture logs a warning and never fails the run.

Lab reset behavior:

- `smoke:hyperv:reset` installs a root-owned `mos-lab-reset-agent.service` only for the USB/Hyper-V front door and enables Suite Manager's lab reset endpoint with `MOS_LAB_RESET_ENABLED=1`.
- The endpoint schedules the reset internally, returns immediately, and then the agent clears Suite Manager state, Homepage edits, app routes, app containers, app networks, and app Docker volumes before restarting the control plane.
- Non-lab installs render the same code but keep `MOS_LAB_RESET_ENABLED=0`, so `/suite-manager/api/lab/reset` returns `LAB_RESET_DISABLED`.

Troubleshooting:

- If app routes fail to resolve after a VM reset, open Suite Manager's Apps page and copy the Hyper-V hosts repair command from Advanced details, or rerun the Hyper-V reset harness that writes the hosts block.
- If DNS-01 succeeds but HTTPS Home does not load from Windows, confirm local DNS points `home.<base-domain>` and app subdomains at the VM LAN IP.
- If Backup is skipped, confirm the Hyper-V smoke VM has the second backup disk mounted at `/media/mos-backup` and the backup agent is running.
