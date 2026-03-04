# My-Own-Suite - VPS Deployment

## Build and Run Locally

### Quick commands from repo root

```bash
# Full reset + rebuild of the entire VPS stack (destructive: removes volumes/data)
npm run vps:rebuild
```

```bash
# Navigate to deploy/vps
cd deploy/vps

# Copy example env files to .env (required before first run)
cp .env.example .env
cp apps/homepage/.env.example apps/homepage/.env
cp apps/seafile/.env.example apps/seafile/.env
cp apps/onlyoffice/.env.example apps/onlyoffice/.env
cp apps/immich/.env.example apps/immich/.env
cp apps/radicale/.env.example apps/radicale/.env
cp apps/stirling-pdf/.env.example apps/stirling-pdf/.env
cp apps/vaultwarden/.env.example apps/vaultwarden/.env

# Start core services (homepage + caddy)
docker compose up -d

# Start with Seafile
docker compose --profile seafile up -d

# Start with OnlyOffice
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

### Access
- Homepage: http://homepage.localhost/
- Seafile: http://seafile.localhost/
- OnlyOffice: http://onlyoffice.localhost/
- Immich: http://immich.localhost/
- Radicale: http://radicale.localhost/
- Stirling PDF: http://stirling-pdf.localhost/
- Vaultwarden: http://vaultwarden.localhost/

### Local OnlyOffice + Seafile note
- `.localhost` domains resolve to loopback inside containers.
- Set `ONLYOFFICE_INTERNAL_SEAFILE_URL=http://seafile` in `apps/seafile/.env` so OnlyOffice backend callbacks/downloads use Docker-internal networking.
- After pulling changes, restart the relevant services:
```bash
docker compose up -d --build seafile onlyoffice caddy
```

## Configuration

### Architecture
```
deploy/vps/
|-- .env                         # DOMAIN variable (shared)
|-- .env.example
|-- docker-compose.yml
|-- Caddyfile
`-- apps/
    |-- homepage/
    |   |-- .env                 # Service URLs using ${DOMAIN}
    |   `-- .env.example
    |-- seafile/
    |   |-- .env                 # App-specific settings
    |   `-- .env.example
    |-- onlyoffice/
    |   |-- .env                 # App-specific settings
    |   `-- .env.example
    |-- immich/
    |   |-- .env                 # App-specific settings
    |   `-- .env.example
    |-- radicale/
    |   |-- .env                 # App-specific settings
    |   `-- .env.example
    |-- stirling-pdf/
    |   |-- .env                 # App-specific settings
    |   `-- .env.example
    `-- vaultwarden/
        |-- .env                 # App-specific settings
        `-- .env.example
```

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
- Caddy routes: `homepage.{$DOMAIN}`, `seafile.{$DOMAIN}`, `onlyoffice.{$DOMAIN}`, `immich.{$DOMAIN}`, `radicale.{$DOMAIN}`, `stirling-pdf.{$DOMAIN}`, `vaultwarden.{$DOMAIN}`
- Service URLs: `http://seafile.${DOMAIN}`, `http://onlyoffice.${DOMAIN}`, `http://immich.${DOMAIN}`, `http://radicale.${DOMAIN}`, `http://stirling-pdf.${DOMAIN}`, `http://vaultwarden.${DOMAIN}`
- Homepage links: same URLs from `apps/homepage/.env`

## Adding a New App

### 1. Create the app directory and .env.example
Create `deploy/vps/apps/<app-name>/.env.example`:

```env
# <App Name> Configuration
# Copy this file to .env and configure

# App-specific settings only (no domain - that comes from root .env)
ADMIN_TOKEN=
SOME_SETTING=value
```

### 2. Copy and configure the .env file
```bash
cp apps/<app-name>/.env.example apps/<app-name>/.env
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
      - ./apps/<app-name>/.env
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
Add to `deploy/vps/apps/homepage/.env`:
```env
<APP_NAME>_URL=http://<app-name>.${DOMAIN}
```

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
