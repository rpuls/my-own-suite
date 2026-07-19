# MOS Infrastructure

Shared runtime substrate lives here when it is not owned by one app.

This area owns Caddy base configuration, the narrow control-plane runtime, Homepage assets, installer substrate, Docker build conventions, projection contracts, and generated-output schemas.

Placement rule:

- App-specific Dockerfiles and snippets belong in `apps/<app>/`.
- Shared Caddy/Compose/Docker substrate belongs here.
- Suite Manager orchestrates state and intent; system agents apply privileged host changes.

## Control-Plane Bootstrap Shape

The first installer contract is control-plane-only. It renders shared inputs for cloud-init, USB/autoinstall, and SSH/bootstrap paths without requiring a `.env` file, and the cloud/SSH bootstrap currently installs the first runnable Suite Manager process behind Caddy on Ubuntu 24.04.

Required runtime values for the first milestone are discoverable or defaulted:

- `MOS_REPO_URL`
- `MOS_REPO_REF`
- `MOS_DOMAIN`
- `MOS_INSTALL_ROOT`
- `MOS_STATE_ROOT`
- `MOS_RUNTIME_USER`
- `MOS_COMPONENTS`

The generated contract also records `MOS_OWNER_SETUP=suite-manager-browser` and `MOS_APP_SELECTION=suite-manager-after-install` so installer paths cannot accidentally reintroduce owner credentials or app-specific setup before first boot.

Public cloud-init installs use `home.<public-ip>.sslip.io`, ask Caddy to obtain a public certificate automatically, and configure UFW to preserve SSH while allowing inbound HTTP and HTTPS. The installer creates a one-time owner-claim URL in a root-owned secret file and prints it at completion. HTTP remains available only to explain an HTTPS/provider-firewall failure; first-owner creation requires both HTTPS and the claim secret. USB/LAN bootstrap behavior is unchanged.

Current first-boot services:

- `mos-suite-manager.service` runs the MOS Suite Manager backend/frontend from the selected repo/ref.
- `mos-homepage.service` runs the digest-pinned Homepage image with config copied to `/var/lib/mos/homepage/config`.
- Homepage is published only on `127.0.0.1:3200`; this control-plane container is the intentionally narrow Docker exception before the general app lifecycle design.
- Caddy proxies only `home.<domain>` to Suite Manager on loopback; Suite Manager owns `/suite-manager/` on that origin.
- Suite Manager authenticates Home requests and proxies the private Homepage upstream. Caddy does not validate sessions and has no direct Homepage route.
- Suite Manager starts after and wants Homepage, but does not use a stop-propagating requirement; restarting Homepage during a customization apply must not restart the API serving that request.

The shared runtime renderer is `control-plane-runtime.cjs`. It pulls the pinned stock `ghcr.io/gethomepage/homepage` image and runs it as `mos-homepage`; the application code lives in that container image, while durable runtime config is mounted from `/var/lib/mos/homepage/config`. Local tile images are mounted from its `images/` child into `/app/public/images`.

## Repo-Built Caddy

Ubuntu's stock Caddy package does not include external DNS providers. `caddy/Dockerfile` therefore pins Caddy 2.10.2, its builder image digest, and `github.com/caddy-dns/cloudflare@v0.2.4`. Bootstrap builds it reproducibly, installs it at `/usr/local/libexec/mos/caddy`, configures the packaged systemd service to use that path, and fails unless `caddy list-modules` contains `dns.providers.cloudflare`. Managed bootstrap/update runs rebuild and refresh the same binary.

The HTTPS renderer emits only MOS-owned configuration. It retains the original HTTP bootstrap host, redirects the configured HTTP Home host to HTTPS, sends HTTPS Home traffic only to Suite Manager, and references the Cloudflare token only through `{env.CLOUDFLARE_API_TOKEN}`. Caddy owns certificate issuance and renewal after a validated reload; there is never a direct Caddy-to-Homepage route.

Repo-owned defaults under `homepage/` seed runtime state once, then only fill missing files, so Suite Manager edits survive bootstrap/update runs. `services.template.yaml` is the editable dashboard source and `services.yaml` is its generated stock Homepage projection. Generated external home-service routes live separately at `/etc/caddy/mos-homepage-routes.caddy`; both bootstrap HTTP and DNS-01 Caddy configurations import it, while the HTTPS agent continues to own the main Caddyfile and secret environment. Customize cannot rewrite those HTTPS-owned files or route directly to Homepage.

The Homepage agent stages and validates candidate YAML, projections, and the MOS route snippet, atomically replaces changed outputs, restarts only Homepage when its files changed, reloads only Caddy when routes changed, and restores the previous files and services on failure. It retains a bounded ten-checkpoint history. Homepage YAML contains dashboard presentation and narrow user-managed network-service metadata only, never app installation configuration or secrets.

The host restart budget is 60 seconds, above the observed container/systemd shutdown lifecycle, and the Suite Manager agent client budget is longer. A genuine timeout still triggers rollback; normal restarts do not discard a successfully validated edit merely because they exceed the old 20-second generic command timeout.
