# VPS Deployment

Self-hosted services suite with Homepage dashboard, Vaultwarden password manager, and Caddy reverse proxy.

## Quick Start

1. **Copy environment file**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your domain**
   ```env
   DOMAIN=yourdomain.com
   BASE_URL=https://yourdomain.com
   HOMEPAGE_ALLOWED_HOSTS=yourdomain.com
   VAULTWARDEN_URL=https://yourdomain.com/vaultwarden/
   ```

3. **Deploy**
   ```bash
   docker-compose up -d
   ```

4. **Access your services**
   - Dashboard: `https://yourdomain.com/`
   - Vaultwarden: `https://yourdomain.com/vaultwarden/`

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DOMAIN` | Your domain (no protocol) | `example.com` |
| `BASE_URL` | Full URL with protocol | `https://example.com` |
| `HOMEPAGE_ALLOWED_HOSTS` | Host for homepage validation | `example.com` |
| `VAULTWARDEN_URL` | Full Vaultwarden URL with trailing slash | `https://example.com/vaultwarden/` |

### Optional Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VAULTWARDEN_ADMIN_TOKEN` | Admin access token | (empty) |
| `VAULTWARDEN_SIGNUPS_ALLOWED` | Allow new users | `true` |
| `TEST_MESSAGE` | Test message on dashboard | (empty) |

## Customizing the Dashboard

Edit `services/homepage/config/services.template.yaml` to add/modify services.

```yaml
- My Category:
    - My Service:
        href: ${MY_SERVICE_URL}    # Placeholder from env var
        description: My service
        icon: service.png

- Static Category:
    - Static Service:
        href: https://example.com  # Static URL, always visible
        description: Always shown
        icon: mdi:web
```

## Local Development

For local testing with `localhost`:

```env
DOMAIN=localhost
BASE_URL=https://localhost
HOMEPAGE_ALLOWED_HOSTS=localhost
VAULTWARDEN_URL=https://localhost/vaultwarden/
```

Note: Caddy uses self-signed certificates for localhost. Accept the browser warning.

## File Structure

```
vps/
├── .env                    # Your configuration (gitignored)
├── .env.example            # Template
├── docker-compose.yml      # Main deployment file
├── Caddyfile               # Reverse proxy config
├── services/
│   ├── homepage/           # Dashboard service
│   └── vaultwarden/        # Password manager
└── scripts/
    └── install.sh          # Server setup script