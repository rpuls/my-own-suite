# My-Own-Suite - VPS Deployment

## Build and Run Locally

### Quick commands from repo root

```bash
# 1) Create any missing env files from .env.template templates
npm run vps:init

# 2) Optional: customize values in deploy/vps/**/*.env
#    (required secrets are auto-generated during vps:init)

# 3) Validate required values and cross-file wiring
npm run vps:doctor

# 4) Build and start the full stack (non-destructive)
npm run vps:up
```

Need a full destructive reset (removes volumes and data)?

```bash
npm run vps:rebuild
```

Manual suite update workflow:

```bash
# Check whether a newer suite release is available
npm run update:check

# Inspect the last updater state written on this machine
npm run update:status

# Apply a specific release only when you are ready
npm run update:apply -- --target 0.7.2 --yes

# Or apply the latest stable release resolved by the updater
npm run update:apply -- --target latest --yes
```

The updater is intentionally manual. It never runs automatically in the background.

Manual compose commands (advanced):

```bash
# Navigate to deploy/vps
cd deploy/vps

# The default Compose project name is "mos"

# Start core services (homepage + caddy)
docker compose up -d

# Start with Seafile
docker compose --profile seafile up -d

# Start with ONLYOFFICE
docker compose --profile onlyoffice up -d

# Start with Immich
docker compose --profile immich up -d

# Start with Radicale
docker compose --profile radicale up -d

# Start with Stirling PDF
docker compose --profile stirling-pdf up -d

# Start with Vaultwarden
docker compose --profile vaultwarden up -d

# Stop all services
docker compose down
```

Generated Docker resources such as the default network and named volumes now use the `mos` project prefix instead of `vps`.

### Access
- Homepage: http://homepage.localhost/
- Suite Manager: http://suite-manager.localhost/setup/
- Seafile: http://seafile.localhost/
- ONLYOFFICE: http://onlyoffice.localhost/
- Immich: http://immich.localhost/
- Radicale: http://radicale.localhost/
- Stirling PDF: http://stirling-pdf.localhost/
- Vaultwarden: https://vaultwarden.localhost/

### Local ONLYOFFICE + Seafile note
- `*.localhost` domains resolve to loopback locally.
- Set `ONLYOFFICE_INTERNAL_SEAFILE_URL=http://seafile` in `services/seafile/.env` so ONLYOFFICE backend callbacks/downloads use Docker-internal networking.
- After pulling changes, restart the relevant services:
```bash
docker compose up -d --build seafile onlyoffice caddy
```

## Configuration

### Architecture
```
deploy/vps/
|-- .env                         # DOMAIN variable (shared)
|-- .env.template
|-- docker-compose.yml
|-- Caddyfile
|-- apps/
|   `-- ...
`-- services/
    |-- suite-manager/
    |   |-- .env                 # Shared user-facing values and onboarding state config
    |   `-- .env.template
    |-- homepage/
    |   |-- .env                 # Homepage settings
    |   `-- .env.template
    |-- immich/
    |   |-- .env                 # Immich server settings
    |   `-- .env.template
    |-- immich-machine-learning/
    |   |-- .env                 # Immich ML settings
    |   `-- .env.template
    |-- immich-postgres/
    |   |-- .env                 # Immich PostgreSQL settings
    |   `-- .env.template
    |-- immich-valkey/
    |   |-- .env                 # Immich Valkey settings
    |   `-- .env.template
    |-- seafile/
    |   |-- .env                 # Seafile server settings
    |   `-- .env.template
    |-- seafile-mysql/
    |   |-- .env                 # Seafile MySQL settings
    |   `-- .env.template
    |-- seafile-memcached/
    |   |-- .env                 # Seafile Memcached settings
    |   `-- .env.template
    |-- onlyoffice/
    |   |-- .env                 # ONLYOFFICE settings
    |   `-- .env.template
    |-- radicale/
    |   |-- .env                 # Radicale settings
    |   `-- .env.template
    |-- stirling-pdf/
    |   |-- .env                 # Stirling PDF settings
    |   `-- .env.template
    |-- vaultwarden/
    |   |-- .env                 # Vaultwarden app settings
    |   `-- .env.template
    `-- vaultwarden-postgres/
        |-- .env                 # Vaultwarden PostgreSQL settings
        `-- .env.template
```

Shared configuration model:
- `deploy/vps/.env`: framework-level values such as `DOMAIN`
- `deploy/vps/services/suite-manager/.env`: shared user-facing values, auth inputs, and onboarding controls reused across the stack
- `deploy/vps/services/<service>/.env`: service-specific runtime settings for all deployable services

Optional shared SMTP model:
- Configure SMTP once in `deploy/vps/services/suite-manager/.env`.
- Leave `SMTP_ENABLED=false` if you do not want mail features yet.
- Compatible apps can reuse that shared config without maintaining separate SMTP credentials per service.
- Current shared SMTP consumers in this repo: Seafile and Vaultwarden.

### Optional SMTP setup

SMTP is an advanced optional feature.

The shared SMTP values still live in `deploy/vps/services/suite-manager/.env`, but the canonical guidance now lives in the dedicated advanced SMTP doc:

- [Optional email with SMTP](/docs/optional-email-with-smtp)

Operational summary:
- Leave `SMTP_ENABLED=false` if you do not need email-backed app features.
- Compatible apps currently include Seafile and Vaultwarden.
- `npm run vps:doctor` validates the SMTP fields only when SMTP is enabled.
- Misconfigured SMTP can make app actions feel slow because some apps send mail during the request itself.

### Manual updates

The first updater foundation is host-side and user-triggered only.

- `npm run update:check` compares the installed suite version with the latest stable release metadata.
- `npm run update:status` shows the last updater state recorded in `.mos-updater/state.json`.
- `npm run update:apply -- --target <version> --yes` fetches the matching git tag, validates release metadata, applies own-infra system migrations, runs `vps:init`, `vps:doctor`, Compose validation, and then applies the stack update with `vps:up`.
- `npm run update:apply -- --target latest --yes` resolves the latest stable release first and then follows the same path.

Safety notes:
- The updater refuses to apply if the git working tree is not clean.
- The updater does not run automatically; every apply must be started by the user.
- The updater state file is local-only and is ignored by git.
Container versioning model:
- `docker-compose.yml` should use `build` (not direct `image`) for repo-managed services.
- Base images are pinned in app Dockerfiles under `apps/<app>/`.
- Dockerfile naming convention:
  - Primary service: `apps/<app>/Dockerfile`
  - Additional services: `apps/<app>/Dockerfile.<service>`

### Change Domain (Local -> Production)
Edit `deploy/vps/.env`:
```env
DOMAIN=localhost        # Local
DOMAIN=yourdomain.com   # Production
```

All services automatically use the new domain:
- Caddy routes: `homepage.{$DOMAIN}`, `suite-manager.{$DOMAIN}`, `seafile.{$DOMAIN}`, `onlyoffice.{$DOMAIN}`, `immich.{$DOMAIN}`, `radicale.{$DOMAIN}`, `stirling-pdf.{$DOMAIN}`, `vaultwarden.{$DOMAIN}`
- Service URLs: `http://homepage.${DOMAIN}`, `http://suite-manager.${DOMAIN}/setup`, `http://seafile.${DOMAIN}`, `http://onlyoffice.${DOMAIN}`, `http://immich.${DOMAIN}`, `http://radicale.${DOMAIN}`, `http://stirling-pdf.${DOMAIN}`, `https://vaultwarden.${DOMAIN}`

Local Vaultwarden HTTPS note:
- Caddy now serves Vaultwarden over HTTPS so the signup flow can run locally.
- On `localhost`, Caddy will use a local certificate. Your browser may show an untrusted certificate warning until you trust Caddy's local CA; for temporary testing you can bypass the warning in the browser.
- Homepage links: same URLs from `services/homepage/.env`

## Adding a New App

### 1. Create env templates
Create a service-level template for runtime settings:

```env
# deploy/vps/services/<service-name>/.env.template
# <Service Name> Configuration
SERVICE_SETTING=value
```

### 2. Copy and configure the .env file
```bash
cp services/<service-name>/.env.template services/<service-name>/.env
```

### 3. Add service to docker-compose.yml
```yaml
  <app-name>:
    build:
      context: ../../apps/<app-name>
      dockerfile: Dockerfile
    container_name: mos-<app-name>
    restart: unless-stopped
    profiles:
      - <app-name>
    env_file:
      - .env
      - ./services/<app-name>/.env
    environment:
      - DOMAIN=http://<app-name>.${DOMAIN}  # If app needs its URL
    volumes:
      - <app-name>_data:/data
    networks:
      - mos-network
```

If the app needs multiple containers, add additional root-level Dockerfiles:
- `apps/<app-name>/Dockerfile.<service>`
- In compose use `build.dockerfile: Dockerfile.<service>`
- Prefer `./services/<service-name>/.env` for service-specific env files

Add the volume:
```yaml
  <app-name>_data:
```

### 4. Add subdomain route to Caddyfile
```caddyfile
# <App Name>
http://<app-name>.{$DOMAIN} {
	reverse_proxy <app-name>:<port>
}
```

### 5. Add URL to Homepage
Add to `deploy/vps/services/homepage/.env`:
```env
<APP_NAME>_URL=http://<app-name>.${DOMAIN}
```

If the app requires HTTPS-aware browser flows, use `https://` instead. Vaultwarden is the current example.

### 6. Add tile to Homepage template
Add to `apps/homepage/config/services.template.yaml`:
```yaml
- Category Name:
    - <App Name>:
        href: ${<APP_NAME>_URL}
        description: App description
        icon: app-icon.png
```

### 7. Rebuild the Homepage container
The homepage copies `services.template.yaml` at build time. After modifying it:
```bash
docker compose up -d --build homepage
```

### 8. Test the deployment locally
```bash
# Start with the new app profile
docker compose --profile <app-name> up -d

# Check container status
docker compose ps

# Check app logs (look for initialization errors)
docker compose logs <app-name> --tail 50

# Test the app is accessible (should return 200, 302, or similar)
curl -sI http://<app-name>.localhost/

# Verify homepage shows the new tile
docker exec mos-homepage cat /app/config/services.yaml
```
