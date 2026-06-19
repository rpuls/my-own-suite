# V2 Infrastructure

Shared runtime substrate lives here when it is not owned by one app.

Use this area for future Caddy base config, Compose assembly/templates, Docker build conventions, projection contracts, and generated-output schemas.

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
- Caddy proxies `suite-manager.<domain>` to Suite Manager.
- Caddy serves `homepage.<domain>` as a placeholder until the real V2 Homepage role is implemented.
