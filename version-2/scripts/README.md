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
