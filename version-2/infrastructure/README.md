# V2 Infrastructure

Shared runtime substrate lives here when it is not owned by one app.

Use this area for Caddy base config, the narrow control-plane runtime, future Compose assembly/templates, Docker build conventions, projection contracts, and generated-output schemas.

Placement rule:

- App-specific Dockerfiles and snippets belong in `version-2/apps/<app>/`.
- Shared Caddy/Compose/Docker substrate belongs here.
- Suite Manager orchestrates state and intent; system agents apply privileged host changes.

## Control-Plane Bootstrap Shape

The first installer contract is control-plane-only. It renders shared inputs for cloud-init, USB/autoinstall, and SSH/bootstrap paths without requiring a `.env` file, and the cloud/SSH bootstrap currently installs the first runnable Suite Manager process behind Caddy on Ubuntu 24.04.

Required runtime values for the first milestone are discoverable or defaulted:

- `MOS_V2_REPO_URL`
- `MOS_V2_REPO_REF`
- `MOS_V2_DOMAIN`
- `MOS_V2_INSTALL_ROOT`
- `MOS_V2_STATE_ROOT`
- `MOS_V2_RUNTIME_USER`
- `MOS_V2_COMPONENTS`

The generated contract also records `MOS_V2_OWNER_SETUP=suite-manager-browser` and `MOS_V2_APP_SELECTION=suite-manager-after-install` so installer paths cannot accidentally reintroduce owner credentials or app-specific setup before first boot.

Current first-boot services:

- `mos-v2-suite-manager.service` runs the V2 Suite Manager backend/frontend from the selected repo/ref.
- `mos-v2-homepage.service` runs the digest-pinned Homepage image with config copied to `/var/lib/mos-v2/homepage/config`.
- Homepage is published only on `127.0.0.1:3200`; this control-plane container is the intentionally narrow Docker exception before the general app lifecycle design.
- Caddy proxies both `home.<domain>` and `suite-manager.<domain>` to Suite Manager on loopback.
- Suite Manager authenticates Home requests and proxies the private Homepage upstream. Caddy does not validate sessions and has no direct Homepage route.

The shared runtime renderer is `control-plane-runtime.cjs`. Homepage starts before Suite Manager, and Caddy starts after Suite Manager. Minimal empty-dashboard YAML plus MOS `custom.css` and account navigation live under `homepage/`.
