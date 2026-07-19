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

## Hyper-V Full E2E

The Hyper-V full E2E suite runs against a real, already-running MOS Hyper-V install. It does not create or destroy the VM, but by default it asks the Hyper-V lab install to reset MOS application state before the browser flow starts. Start or reset Hyper-V yourself first, wait for Suite Manager readiness, then run the suite from Windows:

```powershell
cmd /c npm run e2e:full
cmd /c npm run e2e:full:headed
```

Create a local ignored config file before running:

```powershell
Copy-Item test\e2e\.env.example test\e2e\.env
```

Required values:

- `MOS_E2E_BASE_URL`: the Home origin, for example `http://home.mos.home`.
- `MOS_E2E_OWNER_EMAIL` and `MOS_E2E_OWNER_PASSWORD`: used to create the owner on a fresh install or sign in on an existing one.
- App setup passwords for packages that need human-supplied credentials, especially Radicale, Seafile, and Vaultwarden.
- `MOS_E2E_RESET_BEFORE_RUN`: defaults to `1`. The test calls the lab-only `/suite-manager/api/lab/reset` endpoint so repeated failures can be rerun without reinstalling the VM. Set it to `0` only when intentionally preserving current Suite Manager/Homepage/app state.

Before DNS-01 runs, Windows must resolve both the bootstrap hosts, such as `home.mos.home`, and the post-DNS-01 hosts, such as `home.hyperv.diemernet.uk`, to the Hyper-V guest IP. `smoke:hyperv:reset` writes both sets into the marked hosts block and flushes DNS automatically. If you use another DNS-01 lab domain, set `MOS_HYPERV_EXTRA_HOST_DOMAINS` before reset or add equivalent local DNS/hosts entries yourself.

DNS-01 values for the full Hyper-V regression:

- Set `MOS_E2E_DNS01_BASE_DOMAIN` to the Cloudflare-managed MOS base domain, such as `mos.example.com`.
- Set `CLOUDFLARE_API_TOKEN` in `.env`; never commit it.
- The full Hyper-V regression applies DNS-01 after the first pre-DNS app phase and before post-DNS app installs. If both DNS values are present, the harness enables DNS-01 automatically even if an old local `.env` still contains `MOS_E2E_ENABLE_DNS01=0`.

Default coverage:

- Owner creation or sign-in.
- Dashboard/Homepage reachability.
- Homepage customization with one external link and one safe home-service route.
- Restore checkpoint creation after owner setup, Homepage customization, and the first pre-DNS app install.
- App catalog package installation in three phases: the first pre-DNS app is installed before backup, remaining pre-DNS apps are installed before DNS-01, and post-DNS apps default to Vaultwarden, Seafile, and ONLYOFFICE after DNS-01.
- Runtime health/projection polling through Suite Manager's authenticated APIs.
- Homepage app tile URL checks before and after DNS-01, so existing app shortcuts are verified after HTTPS/public URL reconciliation and later apps are verified with final `https://<app>.<base-domain>/` URLs.
- Homepage tile click-through checks for installed apps, including login validation for app packages with web or HTTP authentication where the package exposes test credentials.
- App route checks that fail on server errors. Vaultwarden direct route checks are skipped on plain HTTP because the web vault requires HTTPS for normal browser loading.
- Seafile plus ONLYOFFICE connection state.
- Restore from the early backup checkpoint, followed by assertions that the owner, Homepage customization, and the first-app catalog state are restored while later apps are rolled back.

Opt-in or deferred coverage:

- Lifecycle stop/start is opt-in with `MOS_E2E_ENABLE_LIFECYCLE=1`.
- Restore validation defaults to on for the Hyper-V full suite. Set `MOS_E2E_ENABLE_RESTORE=0` only when diagnosing an earlier phase and intentionally leaving the post-test app state in place.
- Update validation is intentionally not part of the default command yet because it depends on pushed update commits.

The suite stores traces, screenshots, videos, and the HTML report under `test/e2e/` on failure. It keeps secrets in `.env`, avoids printing request bodies, and uses generated or local test credentials only for app setup.

Lab reset behavior:

- `smoke:hyperv:reset` installs a root-owned `mos-lab-reset-agent.service` only for the USB/Hyper-V front door and enables Suite Manager's lab reset endpoint with `MOS_LAB_RESET_ENABLED=1`.
- The endpoint schedules the reset internally, returns immediately, and then the agent clears Suite Manager state, Homepage edits, app routes, app containers, app networks, and app Docker volumes before restarting the control plane.
- Non-lab installs render the same code but keep `MOS_LAB_RESET_ENABLED=0`, so `/suite-manager/api/lab/reset` returns `LAB_RESET_DISABLED`.

Troubleshooting:

- If app routes fail to resolve after a VM reset, open Suite Manager's Apps page and copy the Hyper-V hosts repair command from Advanced details, or rerun the Hyper-V reset harness that writes the hosts block.
- If DNS-01 succeeds but HTTPS Home does not load from Windows, confirm local DNS points `home.<base-domain>` and app subdomains at the VM LAN IP.
- If Backup is skipped, confirm the Hyper-V smoke VM has the second backup disk mounted at `/media/mos-backup` and the backup agent is running.
