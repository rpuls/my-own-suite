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
- Caddy proxies only `home.<domain>` to Suite Manager on loopback; Suite Manager owns `/suite-manager/` on that origin.
- Suite Manager authenticates Home requests and proxies the private Homepage upstream. Caddy does not validate sessions and has no direct Homepage route.

The shared runtime renderer is `control-plane-runtime.cjs`. It pulls the pinned stock `ghcr.io/gethomepage/homepage` image and runs it as `mos-v2-homepage`; the application code lives in that container image, while durable runtime config is mounted from `/var/lib/mos-v2/homepage/config`. Local tile images are mounted from its `images/` child into `/app/public/images`.

## Repo-Built Caddy

Ubuntu's stock Caddy package does not include external DNS providers. `caddy/Dockerfile` therefore pins Caddy 2.10.2, its builder image digest, and `github.com/caddy-dns/cloudflare@v0.2.4`. Bootstrap builds it reproducibly, installs it at `/usr/local/libexec/mos-v2/caddy`, configures the packaged systemd service to use that path, and fails unless `caddy list-modules` contains `dns.providers.cloudflare`. Managed bootstrap/update runs rebuild and refresh the same binary.

The HTTPS renderer emits only MOS-owned configuration. It retains the original HTTP bootstrap host, redirects the configured HTTP Home host to HTTPS, sends HTTPS Home traffic only to Suite Manager, and references the Cloudflare token only through `{env.CLOUDFLARE_API_TOKEN}`. Caddy owns certificate issuance and renewal after a validated reload; there is never a direct Caddy-to-Homepage route.

Repo-owned defaults under `homepage/` seed runtime state once, then only fill missing files, so future Suite Manager edits survive bootstrap/update runs. The seed marker also upgrades the pre-editor V2 prototype config once. `services.template.yaml` is the intended editable source and `services.yaml` is the stock Homepage projection used today. The MOS theme CSS and browser theme bootstrap follow the proven V1 Homepage presentation, while the MOS tile mark is refreshed from canonical V2 branding. A later customization slice can add validation, template generation, and a narrow system-agent restart action without moving configuration into source code or changing the public auth boundary.
