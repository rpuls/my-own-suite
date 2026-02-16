# My-Own-Suite VPS Deployment

This directory contains the Docker Compose-based deployment for running My-Own-Suite on a VPS or local server.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    VPS Deployment                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌─────────┐    ┌─────────────┐    ┌─────────────┐    │
│   │  Caddy  │───▶│  Homepage   │    │ Vaultwarden │    │
│   │ :80,443 │    │   :3000     │    │    :80      │    │
│   └─────────┘    └─────────────┘    └─────────────┘    │
│        │                                     │          │
│        └─────────────────────────────────────┘          │
│                    mos-network                          │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### Automated Installation

```bash
cd vps
chmod +x scripts/install.sh
./scripts/install.sh
```

### Manual Setup

1. **Prerequisites**:
   - Docker and Docker Compose installed
   - Ports 80 and 443 available

2. **Configure Environment**:
   ```bash
   cp ../.env.example .env
   # Edit .env with your settings
   ```

3. **Start Services**:
   ```bash
   docker compose up -d
   ```

4. **Access Services**:
   - Dashboard: `https://your-domain.com/`
   - Vaultwarden: `https://your-domain.com/vaultwarden/`

## Services

| Service | Port | Description |
|---------|------|-------------|
| Caddy | 80, 443 | Reverse proxy with automatic HTTPS |
| Homepage | 3000 (internal) | Dashboard for all services |
| Vaultwarden | 80 (internal) | Password manager |

## Configuration

### Environment Variables

Create a `.env` file in this directory:

```env
DOMAIN=https://your-domain.com
EMAIL=admin@example.com
VAULTWARDEN_ADMIN_TOKEN=your-secure-token
VAULTWARDEN_SIGNUPS_ALLOWED=true
```

### Caddyfile

The `Caddyfile` configures routing and SSL:

- `/` → Homepage dashboard
- `/vaultwarden/*` → Vaultwarden password manager
- `/vw/*` → Vaultwarden short path

To add new services, add routes to the Caddyfile.

### Homepage Configuration

Homepage config files are located in `../shared/configs/homepage/`:

- `services.yaml` - Service links and status
- `settings.yaml` - Dashboard settings
- `bookmarks.yaml` - Quick links
- `widgets.yaml` - Dashboard widgets
- `docker.yaml` - Docker integration

## Data Persistence

Data is stored in:

```
vps/
└── services/
    └── vaultwarden/
        └── data/     # Password database
```

**Important**: Back up the `services/vaultwarden/data/` directory regularly.

## Management Commands

```bash
# Start services
docker compose up -d

# Stop services
docker compose down

# View logs
docker compose logs -f

# Restart a service
docker compose restart caddy

# Update images
docker compose pull && docker compose up -d
```

## Adding New Services

1. Add service definition to `docker-compose.yml`
2. Add route to `Caddyfile`
3. Add entry to `../shared/configs/homepage/services.yaml`
4. Run `docker compose up -d`

## Security Notes

- Change `VAULTWARDEN_ADMIN_TOKEN` to a secure value
- Set `VAULTWARDEN_SIGNUPS_ALLOWED=false` after creating your account
- Use HTTPS in production (Caddy handles this automatically)
- Keep your `.env` file secure and never commit it

## Troubleshooting

### Port Already in Use

If ports 80 or 443 are in use:
```bash
# Check what's using the ports
sudo lsof -i :80
sudo lsof -i :443
```

### SSL Certificate Issues

Caddy automatically manages certificates. To force renewal:
```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

### Container Won't Start

Check logs for details:
```bash
docker compose logs <service-name>