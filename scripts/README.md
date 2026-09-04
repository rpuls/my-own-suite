# MOS Scripts

MOS operator, installer, smoke, and developer scripts live here.

The DigitalOcean, USB/Hyper-V, cloud-init, and SSH installer and smoke entry points are implemented here and share the repository bootstrap contract.

## No-Preconfig Bootstrap Contract

The first MOS installer surface bootstraps only the control plane:

- Suite Manager
- Caddy
- Homepage
- the installed MOS system agents

Owner credentials are not installer inputs. The owner creates the first account in Suite Manager after first boot. App selections and app-specific environment values are also not installer inputs; those belong to later Suite Manager install flows.

The shared renderer is:

```powershell
npm run install:render -- --target json
npm run install:render -- --target cloud-init --public-ipv4 203.0.113.42
npm run install:render -- --target ssh --repo-ref staging
npm run install:render -- --target usb
```

Rendered installs expose `home.<domain>` as the single MOS origin and `/suite-manager/` as its control-plane path. Caddy terminates only the Home host at Suite Manager; Homepage remains a private loopback upstream. Local renders use `home.localhost`.

Minimum input is intentionally empty. Defaults are:

- repository URL: the MOS GitHub repository
- repository ref: `staging`
- domain: `<public-ip>.sslip.io` when a public IPv4 is known, otherwise `localhost`

The MOS DigitalOcean smoke entry point can create a fresh Droplet and install the MOS control plane:

```powershell
npm run smoke:do:reset
npm run smoke:do:destroy
npm run smoke:do:render
```

`smoke:do:reset` creates or replaces paid DigitalOcean resources through the public development installer, waits for HTTPS Suite Manager readiness, and prints the Home, Suite Manager, and one-time owner setup URLs. `smoke:do:render` is the free dry-run that prints the cloud-init payload without creating resources.

Bootstrap also builds the pinned Cloudflare-capable Caddy binary, verifies its DNS module, installs the separate restricted HTTPS and Homepage agents, seeds the MOS-owned Homepage route snippet, and connects Suite Manager to both protected Unix sockets. No domain credential or DNS token is accepted during installation.

Bootstrap also installs the MOS update agent and connects Suite Manager to its protected local socket. Managed updates call the same repo-owned reconciliation surface after checkout:

```powershell
cmd /c npm run build:client
node scripts/reconcile-system.cjs --dry-run
```

`reconcile-system.cjs` is the Linux/root apply path used by `mos-update-agent`. It refreshes repo-owned systemd units, socket directories, the Cloudflare-capable Caddy binary/override, journald persistence and retention, Suite Manager service wiring, and all MOS host agents. Host settings that both the installer and an update must apply are rendered from one definition in `infrastructure/control-plane-runtime.cjs` and written here too, because the installer is the one path a machine that already exists never runs again. `--dry-run` is for deterministic validation only; it does not touch systemd, Docker, or host files.

The smoke harness reads the ignored local file `.mos-smoke/digitalocean.env`. Smoke credentials, state, and logs all stay under `.mos-smoke/`.

Required for `up`, `reset`, and `destroy`:

- `DIGITALOCEAN_ACCESS_TOKEN`

Optional:

- `MOS_SMOKE_REPO_URL`
- `MOS_SMOKE_REPO_REF`
- `MOS_SMOKE_REGION`
- `MOS_SMOKE_SIZE`
- `MOS_SMOKE_DOMAIN`
- `MOS_SMOKE_SSH_KEY_ID`, `MOS_SMOKE_SSH_KEY_FINGERPRINT`, or `MOS_SMOKE_SSH_KEY_NAME`
- `MOS_SMOKE_SSH_PRIVATE_KEY` (local key path used to retrieve and print the one-time owner claim URL)

The smoke install uses cloud-init, so SSH keys are optional for installation. When both a Droplet SSH key and `MOS_SMOKE_SSH_PRIVATE_KEY` are configured, the harness reads the root-only claim secret over SSH and prints the owner setup URL without storing the token in smoke state or harness-created log files. The legacy `MOS_SMOKE_SSH_*` key names remain accepted for existing local harness configuration.

### Local Hyper-V smoke

The USB-aligned Hyper-V smoke surface has three lifecycle commands:

```powershell
cmd /c npm run smoke:hyperv:reset
cmd /c npm run smoke:hyperv:refresh
cmd /c npm run smoke:hyperv:destroy
```

Run these commands from an Administrator PowerShell terminal. Set `MOS_HYPERV_SWITCH` to override the default switch selection.

The installer seed clones a Git ref inside the guest. It uses `MOS_SMOKE_REPO_REF` when set, otherwise the current non-`main` branch, then `staging` as a fallback. Commit and push the branch you want the VM to install before running `smoke:hyperv:reset`; the seed renderer fails fast if the selected ref does not contain the MOS root layout.

`reset` is the full disposable lifecycle. It removes the exact `mos-usb-smoke` VM and its lab directory, renders a MOS-specific Ubuntu autoinstall seed from the selected bootstrap contract, remasters and verifies a smoke-only auto-boot installer ISO, creates a fresh Generation 2 VM with a blank 64 GB OS disk and a smaller disposable backup disk, attaches the ISO, starts the VM, waits for Suite Manager, writes local Windows host resolution, and prints the working URL summary.

`refresh` is the non-destructive recovery command for an existing lab, built for the one situation that otherwise looks like a broken install: a host PC restart. Hyper-V's Default Switch gets a new subnet on every host boot, so the guest's old IP — and the hosts-file block pointing at it — both go stale; on top of that, Hyper-V's default stop action saves the VM at host shutdown, and the resumed guest still holds its DHCP lease for the old subnet. `refresh` starts the VM if needed, probes readiness for a few minutes (`MOS_HYPERV_REFRESH_PROBE_MINUTES`, default 5), gracefully reboots the guest if it stays unreachable so it re-leases on the current subnet, rewrites the hosts block with the current IP, and prints the URL summary. It also pins the VM to shut down cleanly with the host instead of saving state, so later host restarts boot the guest fresh and `refresh` completes without the reboot step. Run it after every host restart before `npm run e2e:full`; the installed MOS state (owner, apps, backups) is preserved.

`destroy` removes the exact VM, its disposable disk/ISO/build workspace, and the hosts-file entries written by `reset`.

The smoke VM intentionally follows the USB install shape instead of the abandoned Azure/cloud-image path. The blank disk is first in the boot order and the installer ISO is second: on first boot the blank disk falls through to the DVD, and after installation the populated disk wins so the VM does not loop back into the installer.

The harness also attaches `backup.vhdx` as a second disk and the MOS seed formats/mounts that empty disk at `/media/mos-backup` on first boot. This gives the Backup page a ready-made external-style destination for testing backup, download, and restore flows without opening Hyper-V Manager. The default backup disk is 16 GB; set `MOS_HYPERV_BACKUP_DISK_GB` to a whole number from 4 to 256 to change it.

After a Hyper-V VM is already running and reachable, the human operator can run the real full-platform browser regression without reinstalling the VM:

```powershell
cmd /c npm run e2e:full
cmd /c npm run e2e:full:headed
```

The E2E command reads ignored local config from `test/e2e/.env`, never creates or destroys Hyper-V, and keeps destructive restore/update validation out of the default flow. By default it calls the Hyper-V lab-only reset endpoint to clear Suite Manager/Homepage/app state before each run; set `MOS_E2E_RESET_BEFORE_RUN=0` only when preserving current lab state. See `test/README.md` for the env shape and coverage.

### Marketing screenshot pipeline

The full Hyper-V E2E run doubles as the source of the public site's product screenshots. Capture hooks in `test/e2e/support/screenshots.mjs` and the app/backup/update flows save stable-named PNGs (app catalog, pre-install app detail, install progress, privacy posture dialog, Connect section, setup guide, app update review, platform update, backups screen) into the ignored `test/e2e/screenshots/` folder. Captures are best-effort and never fail the regression.

Refreshing the site's screenshots after a UI change is one human-run E2E pass plus one command:

```powershell
cmd /c npm run e2e:full
cmd /c npm run screenshots:update
```

`screenshots:update` copies the last run's captures into `site/src/assets/screenshots/` under the same filenames, reports what was updated and what still carries an older capture, and leaves the changes uncommitted for review. The landing Tour picks up known filenames automatically — a Tour entry whose screenshot has not been captured yet simply does not render, so a partial set never breaks the site build. Run the capture lab with a presentable owner email (the defaults like `owner@example.com` are fine): whatever the lab shows on screen ends up in the published images. Set `MOS_E2E_SCREENSHOT_APP` to change which app's detail view becomes `app-detail-install.png` (default `seafile`).

**Screenshots of states the lab cannot reach.** Two update screens describe a state the capture lab is never in, and neither is fixable by running the lab differently:

- The VM installs official packages from its own `staging` checkout while the app catalog is read from `main`. `staging` leads, so no installed app is ever *behind* its catalog entry and the app update review dialog never opens.
- The VM follows a branch track, so the platform Updates screen reads "Staging branch" and a commit hash rather than the stable-release numbers an owner's machine shows.

`test/e2e/support/screenshot-stubs.mjs` closes both by intercepting the response on its way to the browser (Playwright `page.route`), fetching the real one, and rewriting a few values in it. Nothing in Suite Manager changes: the UI, the components, the styling, and the response shape on the screenshot are all genuine, and only which release the machine happens to be on is arranged. `docs/decisions.md` records why that is acceptable and where the line is.

Four rules hold it in place:

- **Derived, never authored.** Every stub starts from the live response. A hand-written payload drifts from the API and the screenshot silently starts showing a state the product can no longer produce.
- **Bounded by an enforced allow-list.** `STUBBABLE_PATHS` names the exact fields each endpoint may arrange, and every changed field is diffed against it — an unlisted path throws. Version numbers, update availability, track identity, and the changelog summary are stubbable. Privacy posture, permission diffs, structural change lists, package digests, compatibility verdicts, and app counts are not, because a marketing screenshot presents those as facts about MOS.
- **Scoped and reversible.** Routes are installed for one capture and removed immediately after, and the capture re-opens the screen against the real responses before the run continues, so no later assertion can read arranged data.
- **Loud.** Each arranged response logs `[screenshots] arranged <endpoint> …` and each arranged capture logs `[screenshots] <name>.png was ARRANGED: …`, so a reader of the run output can tell arranged captures from real ones. A run that finds a real app update photographs that instead and logs nothing.

A transform whose input is missing what it needs throws rather than half-arranging, and the capture then logs a warning and produces no file — a missing screenshot is a Tour entry that does not render, which is safe, while a wrong one is not. The transforms are pure and unit tested in `test/unit/screenshot-stubs.test.mjs`, with fixtures built by the real producers (`collectStatus` from the update agent, `normalizeStatus` from Suite Manager, `compareAppPackages` from the app update service) rather than hand-written approximations.

The stable-track capture reads the repository's own `CHANGELOG.md`: the newest released section becomes the target version, the one before it becomes the installed version, and its bullets become the release notes — so the release notes in the screenshot are MOS's real release notes. Set `MOS_E2E_SCREENSHOT_UPDATE_APP` to choose which installed app's update review becomes `app-update-review.png` (default order: Vaultwarden, Seafile, Radicale, Stirling PDF).

Inputs are optional and come from `infrastructure/self-host/autoinstall/installer-config/selfhost-installer.env` (or matching `MOS_`-prefixed environment variables such as `MOS_HOSTNAME` and `MOS_STACK_DOMAIN`; bare names like `HOSTNAME` are deliberately ignored because shells export them ambiently) when the file exists:

- `LINUX_PASSWORD` pins the Ubuntu console/SSH login. **When it is not set — the default for `installer:usb` — the ISO contains no password at all.** The autoinstall ships a locked account, and the installed machine generates its own login on first boot, shows it on its console and in Suite Manager, and deletes it once the owner confirms they saved it. That is the only shape a shared or published ISO may have: a build-time password would be identical on every machine flashed from the image and extractable by anyone holding it. Set `LINUX_PASSWORD` only for a machine you own and an ISO you will never share, because that image carries the password.
- The **Hyper-V lab is different on purpose**: `smoke:hyperv:*` builds with `MOS_SEED_PROFILE=lab`, which bakes in the fixed login `mos` / `admin1234`. A disposable VM that both people and coding agents need to SSH into must not require anyone to remember to configure a password first. `LINUX_PASSWORD` still overrides it. Nothing else uses this profile, and `installer:usb` never inherits it.
- A fixed password does not skip the handover: the lab VM still generates the console banner, the Suite Manager panel, and the acknowledge-and-clear flow, so the lab exercises the same path a published install runs. It just knows the answer in advance.
- `USERNAME` defaults to `mos`.
- `HOSTNAME` defaults to `mos`.
- `STACK_DOMAIN` defaults to `mos.home` for real USB installer builds. The Hyper-V lab always renders its seed with `mos.hyperv` instead (override with `MOS_STACK_DOMAIN`), so the Windows hosts entries it writes can never shadow a real `mos.home` install reachable from the same machine.

The Hyper-V seed uses the current bootstrap contract and never embeds a preconfigured Suite Manager owner. Owner setup happens in Suite Manager after first boot.

Readiness and access:

- The command discovers the guest IPv4 from Hyper-V integration data or, when Hyper-V does not report it, from the Windows neighbor table using the VM MAC address.
- It probes both `http://home.<domain>/suite-manager/api/setup/status` and `http://home.<domain>/` with per-request `curl --resolve`, so readiness requires Suite Manager and Homepage without depending on Windows DNS being configured yet.
- After readiness succeeds, it writes this marked block to `C:\Windows\System32\drivers\etc\hosts` and flushes DNS. The block includes `home.<domain>` plus route hosts discovered from local MOS app package manifests for both the bootstrap domain and the DNS-01 E2E domain, so packaged-app smoke and post-HTTPS browser checks do not require a separate hosts edit. The DNS-01 host domain defaults to `hyperv.diemernet.uk`; set `MOS_HYPERV_EXTRA_HOST_DOMAINS` to a comma-separated list to override or add domains for another lab.
- External packages are not discoverable this way. They are installed at runtime from a GitHub repository and have no folder under `apps/`, so the scan above cannot see them and their hostnames would not resolve. They are declared in `scripts/smoke/external-lab-apps.cjs` instead, which applies the same `ext-` prefix the Suite Manager serves them under. Add an entry there when a new external package needs to be reachable in the lab.

```text
# BEGIN MOS HYPERV USB SMOKE
<guest-ip> home.<domain>
<guest-ip> ext-notes.<domain>
<guest-ip> stirling-pdf.<domain>
<guest-ip> vaultwarden.<domain>
<guest-ip> home.hyperv.diemernet.uk
<guest-ip> ext-notes.hyperv.diemernet.uk
<guest-ip> stirling-pdf.hyperv.diemernet.uk
<guest-ip> vaultwarden.hyperv.diemernet.uk
# END MOS HYPERV USB SMOKE
```

- Browser access is through `http://home.<domain>/suite-manager/`, for example `http://home.mos.hyperv/suite-manager/`. The supported control-plane path is `home.<domain>/suite-manager/`.
- The final summary prints the VM name, switch, OS disk, backup disk, installer ISO, IPv4, MOS Home URL, and Suite Manager URL.
- `reset` writes the Home host and known package route hosts into the same marked Windows hosts block for the lab domain (`mos.hyperv` by default) plus the configured DNS-01 test domain, and removes stale copies from earlier VM resets. The temporary Apps page still shows a repair command for app hosts, but the normal Stirling smoke path should not need it. For lower-friction repeated testing across arbitrary domains, a local wildcard DNS override such as `*.test.example.com -> <guest-ip>` in the user's router, AdGuard Home, Unbound, Pi-hole, or other local DNS service is still the cleanest option.

If the wait looks stuck, open Hyper-V Manager, connect to `mos-usb-smoke`, and inspect the Ubuntu console. Useful console checks after login are:

```bash
hostname -I
systemctl status cloud-final.service --no-pager
journalctl -u cloud-final.service -n 120 --no-pager
docker ps
```

Use the non-Docker IPv4 from `hostname -I`; Docker bridge addresses such as `172.17.0.1` and `172.18.0.1` are not the VM LAN address. If SSH is reachable from Windows, the Linux user/password can be used for shell inspection — either the pinned value from `selfhost-installer.env` or the generated password printed by the ISO build.

Set `MOS_HYPERV_READY_TIMEOUT_MINUTES` to override the default 90 minute readiness timeout. The remasterer uses the supported Ubuntu ISO under `infrastructure/self-host/autoinstall/ubuntu-iso/` and Docker Desktop's Linux container engine.

### Explicit DigitalOcean DNS-01 validation

After creating the owner on an existing MOS smoke Droplet and pointing `home.<base-domain>` at it, real DNS-01 validation is available only with explicit confirmation:

```powershell
$env:MOS_DNS01_CONFIRM='APPLY_REAL_DNS01'
$env:MOS_DNS01_BASE_DOMAIN='mos.example.com'
$env:MOS_DNS01_ACME_EMAIL='owner@example.com'
$env:MOS_DNS01_OWNER_EMAIL='owner@example.com'
$env:MOS_DNS01_OWNER_PASSWORD='<owner password>'
$env:CLOUDFLARE_API_TOKEN='<scoped token>'
$env:DIGITALOCEAN_ACCESS_TOKEN='<DigitalOcean token>'
cmd /c npm run smoke:do:dns01
```

The command signs in through the bootstrap URL, submits the production Settings API, and waits for the HTTPS Home status endpoint. It never prints either credential. It refuses to run without the exact confirmation value and existing smoke state.

### MOS-operated nameserver

`scripts/nameserver.cjs` provisions and operates the Easy Door nameserver — the MOS-run box that
answers `local.myownsuite.org`, resolving a name to the private address encoded in it so an owner can
reach their suite without configuring DNS. It is not installed-platform code and ships to nobody; it
manages infrastructure MOS runs. The box itself is defined in `infrastructure/nameserver/` and
injected by cloud-init at create time, so the server holds no state and a rebuild is `destroy` then
`apply`.

```bash
npm run nameserver:render     # print the cloud-init payload; creates nothing, needs no token
npm run nameserver:plan       # what apply would create, and what it costs, against live state
npm run nameserver:status     # current droplet, reserved IP and firewall
npm run nameserver:verify     # acceptance checks against the live Reserved IP
npm run nameserver:ssh-open   # point the firewall's SSH rule at wherever you are now
```

`npm run nameserver:apply` **creates billable DigitalOcean resources** (a $6/mo Droplet plus a
firewall) and `npm run nameserver:destroy` removes them. Treat both the way `AGENTS.md` treats the
DigitalOcean smoke commands: an agent runs them only when explicitly asked. Run `plan` first — it
prices the change against live state before anything is created.

`destroy` keeps the Reserved IP on purpose, because the parent zone's `ns1` A record points at it and
an owner install resolving through this box depends on that address surviving a rebuild. An
unattached Reserved IP is billed, and the next `apply` reattaches it.

`DIGITALOCEAN_ACCESS_TOKEN` is required for everything except `render`. It is read from the
environment, or from `.mos-nameserver.env` or `.mos-smoke/digitalocean.env` — all git-ignored. Run
`node scripts/nameserver.cjs` with no arguments for the full environment-variable list.

The acceptance checks in `infrastructure/nameserver/verify.cjs` also run standalone against a local
container or a public resolver, which is how the delegation is proven end to end:

```bash
node infrastructure/nameserver/verify.cjs 127.0.0.1:15353   # a local test container
node infrastructure/nameserver/verify.cjs <reserved-ip>     # the box itself
node infrastructure/nameserver/verify.cjs 1.1.1.1 --via-resolver
```

They assert both directions of the security contract: private addresses resolve, **public addresses
are refused**, and the box answers nothing outside its own zone. The refusal is not tidiness — without
it the zone is an open redirector lending the `myownsuite.org` name to an attacker's host. Operating
detail and the rebuild runbook are in `infrastructure/nameserver/README.md`.
