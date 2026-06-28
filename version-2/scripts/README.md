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
npm --prefix version-2 run install:render -- --target json
npm --prefix version-2 run install:render -- --target cloud-init --public-ipv4 203.0.113.42
npm --prefix version-2 run install:render -- --target ssh --repo-ref feat/app-platform-v2-lab
npm --prefix version-2 run install:render -- --target usb
```

Rendered installs expose `home.<domain>` as the single MOS origin and `/suite-manager/` as its control-plane path. Caddy terminates only the Home host at Suite Manager; Homepage remains a private loopback upstream. Local renders use `home.localhost`.

Minimum input is intentionally empty. Defaults are:

- repository URL: the MOS GitHub repository
- repository ref: `feat/app-platform-v2-lab`
- domain: `<public-ip>.sslip.io` when a public IPv4 is known, otherwise `localhost`

The V2 DigitalOcean smoke entry point can create a fresh Droplet and install the V2 control plane:

```powershell
npm --prefix version-2 run smoke:do:reset
npm --prefix version-2 run smoke:do:destroy
npm --prefix version-2 run smoke:do:render
```

`smoke:do:reset` creates or replaces paid DigitalOcean resources, waits for Suite Manager readiness, and prints the Home and Suite Manager URLs. `smoke:do:render` is the free dry-run that prints the cloud-init payload without creating resources.

Bootstrap also builds the pinned Cloudflare-capable Caddy binary, verifies its DNS module, installs the separate restricted HTTPS and Homepage agents, seeds the MOS-owned Homepage route snippet, and connects Suite Manager to both protected Unix sockets. No domain credential or DNS token is accepted during installation.

The smoke harness reads the ignored V2-local file `version-2/.mos-smoke/v2-digitalocean.env` (or `.mos-smoke/v2-digitalocean.env` when working inside `version-2`). V2 smoke credentials, state, and logs all stay under `version-2/.mos-smoke/`.

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
cmd /c npm --prefix version-2 run smoke:hyperv:reset
cmd /c npm --prefix version-2 run smoke:hyperv:destroy
```

Run these commands from an Administrator PowerShell terminal. Set `MOS_V2_HYPERV_SWITCH` to override the default switch selection.

`reset` is the full disposable lifecycle. It removes the exact `mos-v2-usb-smoke` VM and its lab directory, renders a V2-specific Ubuntu autoinstall seed from the `feat/app-platform-v2-lab` bootstrap contract, remasters and verifies a smoke-only auto-boot installer ISO, creates a fresh Generation 2 VM with a blank 64 GB disk, attaches the ISO, starts the VM, waits for Suite Manager, writes local Windows host resolution, and prints the working URL summary.

`destroy` removes the exact VM, its disposable disk/ISO/build workspace, and the hosts-file entries written by `reset`.

The smoke VM intentionally follows the USB install shape instead of the abandoned Azure/cloud-image path. The blank disk is first in the boot order and the installer ISO is second: on first boot the blank disk falls through to the DVD, and after installation the populated disk wins so the VM does not loop back into the installer.

Inputs come from `deploy/self-host/autoinstall/installer-config/selfhost-installer.env`:

- `LINUX_PASSWORD` is used for the Ubuntu console/SSH login.
- `USERNAME` defaults to `mos`.
- `HOSTNAME` defaults to `mos`.
- `STACK_DOMAIN` defaults to `mos.home`.

The V2 Hyper-V seed does not embed the old v1 self-host bootstrap or its preconfigured Suite Manager owner. Owner setup should happen in Suite Manager after first boot.

Readiness and access:

- The command discovers the guest IPv4 from Hyper-V integration data or, when Hyper-V does not report it, from the Windows neighbor table using the VM MAC address.
- It probes `http://home.<domain>/suite-manager/api/setup/status` with a per-request `curl --resolve`, so readiness does not depend on Windows DNS being configured yet.
- After readiness succeeds, it writes this marked block to `C:\Windows\System32\drivers\etc\hosts` and flushes DNS. The block includes `home.<domain>` plus route hosts discovered from local V2 app package manifests, so the first packaged-app smoke path does not require a separate hosts edit.

```text
# BEGIN MOS V2 HYPERV USB SMOKE
<guest-ip> home.<domain>
<guest-ip> stirling-pdf.<domain>
<guest-ip> vaultwarden.<domain>
# END MOS V2 HYPERV USB SMOKE
```

- Browser access is through `http://home.<domain>/suite-manager/`, for example `http://home.mos.home/suite-manager/`. Do not use the old v1 `suite-manager.<domain>/setup/` host.
- The final summary prints the VM name, switch, disk, installer ISO, IPv4, MOS Home URL, and Suite Manager URL.
- `reset` writes the Home host and known package route hosts into the same marked Windows hosts block, and removes stale copies from earlier VM resets. The temporary Apps page still shows a repair command for app hosts, but the normal Stirling smoke path should not need it. For lower-friction repeated testing across arbitrary domains, a local wildcard DNS override such as `*.test.example.com -> <guest-ip>` in the user's router, AdGuard Home, Unbound, Pi-hole, or other local DNS service is still the cleanest option.

If the wait looks stuck, open Hyper-V Manager, connect to `mos-v2-usb-smoke`, and inspect the Ubuntu console. Useful console checks after login are:

```bash
hostname -I
systemctl status cloud-final.service --no-pager
journalctl -u cloud-final.service -n 120 --no-pager
docker ps
```

Use the non-Docker IPv4 from `hostname -I`; Docker bridge addresses such as `172.17.0.1` and `172.18.0.1` are not the VM LAN address. If SSH is reachable from Windows, the same Linux user/password from `selfhost-installer.env` can be used for shell inspection.

Set `MOS_V2_HYPERV_READY_TIMEOUT_MINUTES` to override the default 90 minute readiness timeout. The remasterer uses the supported Ubuntu ISO under `deploy/self-host/autoinstall/ubuntu-iso/` and Docker Desktop's Linux container engine.

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
cmd /c npm --prefix version-2 run smoke:do:dns01
```

The command signs in through the bootstrap URL, submits the production Settings API, and waits for the HTTPS Home status endpoint. It never prints either credential. It refuses to run without the exact confirmation value and existing smoke state.
