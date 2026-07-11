# V2 Scripts

V2 operator, installer, smoke, and developer scripts live here.

Future DigitalOcean smoke wrappers and USB/cloud/SSH installer entry points should be rebuilt here instead of importing the old script surface by default.

## No-Preconfig Bootstrap Contract

The first V2 installer surface bootstraps only the control plane:

- Suite Manager
- Caddy
- Homepage
- future system-agent placeholder

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

The V2 DigitalOcean smoke entry point can create a fresh Droplet and install the V2 control plane:

```powershell
npm run smoke:do:reset
npm run smoke:do:destroy
npm run smoke:do:render
```

`smoke:do:reset` creates or replaces paid DigitalOcean resources, waits for Suite Manager readiness, and prints the Home and Suite Manager URLs. `smoke:do:render` is the free dry-run that prints the cloud-init payload without creating resources.

Bootstrap also builds the pinned Cloudflare-capable Caddy binary, verifies its DNS module, installs the separate restricted HTTPS and Homepage agents, seeds the MOS-owned Homepage route snippet, and connects Suite Manager to both protected Unix sockets. No domain credential or DNS token is accepted during installation.

Bootstrap also installs the V2 update agent and connects Suite Manager to its protected local socket. Managed updates call the same repo-owned reconciliation surface after checkout:

```powershell
cmd /c npm run build:client
node scripts/reconcile-system.cjs --dry-run
```

`reconcile-system.cjs` is the Linux/root apply path used by `mos-v2-update-agent`. It refreshes repo-owned systemd units, socket directories, the Cloudflare-capable Caddy binary/override, Suite Manager service wiring, and all V2 host agents. `--dry-run` is for deterministic validation only; it does not touch systemd, Docker, or host files.

The smoke harness reads the ignored V2-local file `.mos-smoke/v2-digitalocean.env` (). V2 smoke credentials, state, and logs all stay under `.mos-smoke/`.

Required for `up`, `reset`, and `destroy`:

- `DIGITALOCEAN_ACCESS_TOKEN`

Optional:

- `MOS_V2_SMOKE_REPO_URL`
- `MOS_V2_SMOKE_REPO_REF`
- `MOS_V2_SMOKE_REGION`
- `MOS_V2_SMOKE_SIZE`
- `MOS_V2_SMOKE_DOMAIN`
- `MOS_V2_SMOKE_SSH_KEY_ID`, `MOS_V2_SMOKE_SSH_KEY_FINGERPRINT`, or `MOS_V2_SMOKE_SSH_KEY_NAME`

The smoke install uses cloud-init, so SSH keys are optional for the install itself but useful for debugging.

### Local Hyper-V smoke

The USB-aligned Hyper-V smoke surface has two lifecycle commands:

```powershell
cmd /c npm run smoke:hyperv:reset
cmd /c npm run smoke:hyperv:destroy
```

Run these commands from an Administrator PowerShell terminal. Set `MOS_V2_HYPERV_SWITCH` to override the default switch selection.

The installer seed clones a Git ref inside the guest. It uses `MOS_V2_SMOKE_REPO_REF` when set, otherwise the current non-`main` branch, then `staging` as a fallback. Commit and push the branch you want the VM to install before running `smoke:hyperv:reset`; the seed renderer fails fast if the selected ref does not contain the MOS2 root layout.

`reset` is the full disposable lifecycle. It removes the exact `mos-v2-usb-smoke` VM and its lab directory, renders a V2-specific Ubuntu autoinstall seed from the selected bootstrap contract, remasters and verifies a smoke-only auto-boot installer ISO, creates a fresh Generation 2 VM with a blank 64 GB OS disk and a smaller disposable backup disk, attaches the ISO, starts the VM, waits for Suite Manager, writes local Windows host resolution, and prints the working URL summary.

`destroy` removes the exact VM, its disposable disk/ISO/build workspace, and the hosts-file entries written by `reset`.

The smoke VM intentionally follows the USB install shape instead of the abandoned Azure/cloud-image path. The blank disk is first in the boot order and the installer ISO is second: on first boot the blank disk falls through to the DVD, and after installation the populated disk wins so the VM does not loop back into the installer.

The harness also attaches `backup.vhdx` as a second disk and the V2 seed formats/mounts that empty disk at `/media/mos-backup` on first boot. This gives the Backup page a ready-made external-style destination for testing backup, download, and restore flows without opening Hyper-V Manager. The default backup disk is 16 GB; set `MOS_V2_HYPERV_BACKUP_DISK_GB` to a whole number from 4 to 256 to change it.

After a Hyper-V VM is already running and reachable, the human operator can run the real full-platform browser regression without reinstalling the VM:

```powershell
cmd /c npm run e2e:full
cmd /c npm run e2e:full:headed
```

The E2E command reads ignored local config from `test/e2e/.env`, never creates or destroys Hyper-V, and keeps destructive restore/update validation out of the default flow. By default it calls the Hyper-V lab-only reset endpoint to clear Suite Manager/Homepage/app state before each run; set `MOS_V2_E2E_RESET_BEFORE_RUN=0` only when preserving current lab state. See `test/README.md` for the env shape and coverage.

Inputs are optional and come from `infrastructure/self-host/autoinstall/installer-config/selfhost-installer.env` (or matching environment variables) when the file exists:

- `LINUX_PASSWORD` is used for the Ubuntu console/SSH login. When it is not set, the seed renderer generates a random password and prints it during the build (also in the final ISO summary). Pin it locally if you need a stable lab login across resets.
- `USERNAME` defaults to `mos`.
- `HOSTNAME` defaults to `mos`.
- `STACK_DOMAIN` defaults to `mos.home`.

The V2 Hyper-V seed does not embed the old v1 self-host bootstrap or its preconfigured Suite Manager owner. Owner setup should happen in Suite Manager after first boot.

Readiness and access:

- The command discovers the guest IPv4 from Hyper-V integration data or, when Hyper-V does not report it, from the Windows neighbor table using the VM MAC address.
- It probes both `http://home.<domain>/suite-manager/api/setup/status` and `http://home.<domain>/` with per-request `curl --resolve`, so readiness requires Suite Manager and Homepage without depending on Windows DNS being configured yet.
- After readiness succeeds, it writes this marked block to `C:\Windows\System32\drivers\etc\hosts` and flushes DNS. The block includes `home.<domain>` plus route hosts discovered from local V2 app package manifests for both the bootstrap domain and the DNS-01 E2E domain, so packaged-app smoke and post-HTTPS browser checks do not require a separate hosts edit. The DNS-01 host domain defaults to `hyperv.diemernet.uk`; set `MOS_V2_HYPERV_EXTRA_HOST_DOMAINS` to a comma-separated list to override or add domains for another lab.

```text
# BEGIN MOS V2 HYPERV USB SMOKE
<guest-ip> home.<domain>
<guest-ip> stirling-pdf.<domain>
<guest-ip> vaultwarden.<domain>
<guest-ip> home.hyperv.diemernet.uk
<guest-ip> stirling-pdf.hyperv.diemernet.uk
<guest-ip> vaultwarden.hyperv.diemernet.uk
# END MOS V2 HYPERV USB SMOKE
```

- Browser access is through `http://home.<domain>/suite-manager/`, for example `http://home.mos.home/suite-manager/`. Do not use the old v1 `suite-manager.<domain>/setup/` host.
- The final summary prints the VM name, switch, OS disk, backup disk, installer ISO, IPv4, MOS Home URL, and Suite Manager URL.
- `reset` writes the Home host and known package route hosts into the same marked Windows hosts block for `STACK_DOMAIN` plus the configured DNS-01 test domain, and removes stale copies from earlier VM resets. The temporary Apps page still shows a repair command for app hosts, but the normal Stirling smoke path should not need it. For lower-friction repeated testing across arbitrary domains, a local wildcard DNS override such as `*.test.example.com -> <guest-ip>` in the user's router, AdGuard Home, Unbound, Pi-hole, or other local DNS service is still the cleanest option.

If the wait looks stuck, open Hyper-V Manager, connect to `mos-v2-usb-smoke`, and inspect the Ubuntu console. Useful console checks after login are:

```bash
hostname -I
systemctl status cloud-final.service --no-pager
journalctl -u cloud-final.service -n 120 --no-pager
docker ps
```

Use the non-Docker IPv4 from `hostname -I`; Docker bridge addresses such as `172.17.0.1` and `172.18.0.1` are not the VM LAN address. If SSH is reachable from Windows, the Linux user/password can be used for shell inspection — either the pinned value from `selfhost-installer.env` or the generated password printed by the ISO build.

Set `MOS_V2_HYPERV_READY_TIMEOUT_MINUTES` to override the default 90 minute readiness timeout. The remasterer uses the supported Ubuntu ISO under `infrastructure/self-host/autoinstall/ubuntu-iso/` and Docker Desktop's Linux container engine.

### Explicit DigitalOcean DNS-01 validation

After creating the owner on an existing V2 smoke Droplet and pointing `home.<base-domain>` at it, real DNS-01 validation is available only with explicit confirmation:

```powershell
$env:MOS_V2_DNS01_CONFIRM='APPLY_REAL_DNS01'
$env:MOS_V2_DNS01_BASE_DOMAIN='mos.example.com'
$env:MOS_V2_DNS01_ACME_EMAIL='owner@example.com'
$env:MOS_V2_DNS01_OWNER_EMAIL='owner@example.com'
$env:MOS_V2_DNS01_OWNER_PASSWORD='<owner password>'
$env:CLOUDFLARE_API_TOKEN='<scoped token>'
$env:DIGITALOCEAN_ACCESS_TOKEN='<DigitalOcean token>'
cmd /c npm run smoke:do:dns01
```

The command signs in through the bootstrap URL, submits the production Settings API, and waits for the HTTPS Home status endpoint. It never prints either credential. It refuses to run without the exact confirmation value and existing smoke state.
