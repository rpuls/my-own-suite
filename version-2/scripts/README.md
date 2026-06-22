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
npm --prefix version-2 run smoke:do:up
npm --prefix version-2 run smoke:do:reset
npm --prefix version-2 run smoke:do:destroy
npm --prefix version-2 run smoke:do:render
```

`smoke:do:up` creates paid DigitalOcean resources, waits for Suite Manager readiness, and prints the Home setup and Suite Manager URLs. `smoke:do:render` is the free dry-run that prints the cloud-init payload without creating resources.

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

Windows 10/11 Pro hosts with Hyper-V can boot the same V2 cloud-init contract in a disposable local VM. Run these commands from an Administrator PowerShell terminal:

```powershell
cmd /c npm --prefix version-2 run smoke:hyperv:render
cmd /c npm --prefix version-2 run smoke:hyperv:up
cmd /c npm --prefix version-2 run smoke:hyperv:reset
cmd /c npm --prefix version-2 run smoke:hyperv:destroy
```

The first `up` downloads and verifies a pinned 574 MB official Ubuntu 24.04 Azure VHD. Hyper-V cannot consume the archive's compressed sparse fixed disk directly, so first setup briefly needs about 34 GB while converting it to a smaller dynamic VHDX. The converted base remains cached under ignored `version-2/.mos-smoke/cache/`; each VM uses disposable differencing and CIDATA disks under `.mos-smoke/hyperv/`. Re-running `up` resumes readiness polling for an incomplete VM when setup was interrupted. `reset` destroys and recreates only the exact `mos-v2-smoke` VM, while `destroy` removes that VM and its disposable disks but retains the verified base image.

The VM uses two virtual CPUs and Hyper-V dynamic memory from 1.5 GB to 4 GB, starting at 2 GB. The harness uses Hyper-V's `Default Switch` when available, otherwise the first external switch. Set `MOS_V2_HYPERV_SWITCH`, `MOS_V2_HYPERV_REPO_URL`, or `MOS_V2_HYPERV_REPO_REF` to override those defaults. DNS-01 is not part of this smoke path; validate it separately only on a representative local network with the user's chosen DNS wildcard override.

### Explicit DNS-01 validation

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
