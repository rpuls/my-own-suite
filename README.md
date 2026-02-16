# My-Own-Suite

A self-hostable personal SaaS stack that gives you full ownership of your data and services. Deploy to a VPS, Railway, or your preferred cloud platform.

## What is My-Own-Suite?

My-Own-Suite is a collection of self-hosted services designed to replace commercial SaaS products with alternatives you control. Whether you want to escape vendor lock-in, protect your privacy, or simply have full control over your infrastructure, this suite provides a clean, modular approach to personal hosting.

### Included Services

| Service | Description | Status |
|---------|-------------|--------|
| [Homepage](https://gethomepage.dev/) | Modern dashboard for all your services | ✅ Ready |
| [Vaultwarden](https://github.com/dani-garcia/vaultwarden) | Bitwarden-compatible password manager | ✅ Ready |

### Planned Services

- **Nextcloud** - File sync and share
- **Immich** - Photo backup and management
- **Paperless-ngx** - Document management
- **Authentik** - Identity provider
- **OnlyOffice** - Document editing

## Deployment Options

My-Own-Suite supports multiple deployment targets with no structural conflicts:

| Platform | Directory | Best For |
|----------|-----------|----------|
| VPS / Docker Compose | [`/vps`](./vps) | Full control, bare metal, private servers |
| Railway | [`/railway`](./railway) | Managed infrastructure, automatic scaling |

Choose your deployment path:

### VPS Deployment

Ideal for self-hosting on your own server or VPS provider (DigitalOcean, Linode, Hetzner, etc.).

```bash
cd vps
chmod +x scripts/install.sh
./scripts/install.sh
```

**Features:**
- Docker Compose orchestration
- Caddy reverse proxy with automatic HTTPS
- All services on a single domain
- Full control over networking

👉 [See VPS Documentation](./vps/README.md)

### Railway Deployment

Ideal for managed cloud hosting with automatic scaling.

```bash
# In Railway Dashboard:
# 1. Create PostgreSQL database
# 2. Deploy services from this repo
# 3. Set environment variables
```

**Features:**
- Service-per-folder model
- Automatic HTTPS
- Independent scaling per service
- No server management

👉 [See Railway Documentation](./railway/README.md)

## Architecture

```
my-own-suite/
├── README.md                 # This file
├── .env.example              # Environment template
├── .gitignore
├── vps/                      # VPS deployment
│   ├── docker-compose.yml    # Main orchestration
│   ├── Caddyfile             # Reverse proxy config
│   ├── scripts/
│   │   └── install.sh        # Automated installer
│   └── services/
│       └── vaultwarden/
│           └── data/         # Persistent storage
├── railway/                  # Railway deployment
│   ├── README.md             # Railway guide
│   └── services/
│       ├── homepage/
│       │   ├── Dockerfile
│       │   ├── railway.json
│       │   └── entrypoint.sh
│       └── vaultwarden/
│           ├── Dockerfile
│           ├── railway.json
│           └── README.md
└── shared/                   # Shared configurations
    └── configs/
        └── homepage/
            ├── services.yaml
            ├── settings.yaml
            ├── bookmarks.yaml
            ├── widgets.yaml
            └── docker.yaml
```

## Philosophy

### Monorepo Approach

My-Own-Suite uses a monorepo structure to keep all deployment options in sync:

- **Single source of truth** - One repository, multiple deployment targets
- **Shared configurations** - Common configs in `/shared` prevent duplication
- **Platform independence** - Each platform's specifics isolated in their directory
- **Future-proof** - Add new platforms without restructuring

### Design Principles

1. **Minimal complexity** - No unnecessary abstractions or tooling
2. **Environment-based config** - No hardcoded domains or secrets
3. **Production-ready** - Security best practices out of the box
4. **Extensible** - Easy to add new services or platforms

## Quick Start

### Prerequisites

- Docker and Docker Compose (for VPS)
- Railway account (for Railway)
- A domain name (recommended)

### VPS Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/my-own-suite.git
cd my-own-suite

# Configure
cp .env.example vps/.env
# Edit vps/.env with your domain and settings

# Deploy
cd vps
docker compose up -d
```

### Railway Quick Start

1. Fork this repository
2. Create a Railway project
3. Add PostgreSQL database
4. Deploy Vaultwarden (root: `railway/services/vaultwarden`)
5. Deploy Homepage (root: `railway/services/homepage`)
6. Set environment variables

## Configuration

### Environment Variables

Core variables used across deployments:

| Variable | Description | Example |
|----------|-------------|---------|
| `DOMAIN` | Your public domain | `https://myserver.com` |
| `VAULTWARDEN_ADMIN_TOKEN` | Admin panel access | Random 48-char string |
| `VAULTWARDEN_SIGNUPS_ALLOWED` | Allow new accounts | `true` / `false` |
| `VAULTWARDEN_URL` | (Railway) Vaultwarden URL | `https://vw.up.railway.app` |

Platform-specific variables are documented in each platform's README.

### Homepage Configuration

Homepage configuration files are in `/shared/configs/homepage/`:

- `services.yaml` - Service links and status monitoring
- `settings.yaml` - Dashboard title, theme, layout
- `bookmarks.yaml` - Quick links
- `widgets.yaml` - Search, resources, etc.
- `docker.yaml` - Docker socket integration (VPS only)

## Security

### Recommendations

1. **Strong tokens**: Generate secure random tokens for `ADMIN_TOKEN`
   ```bash
   openssl rand -base64 48
   ```

2. **Disable signups**: After creating your Vaultwarden account:
   ```env
   VAULTWARDEN_SIGNUPS_ALLOWED=false
   ```

3. **HTTPS**: Always use HTTPS in production
   - VPS: Caddy handles this automatically
   - Railway: Automatic HTTPS

4. **Backups**: Regularly backup your data directories
   - VPS: `vps/services/vaultwarden/data/`
   - Railway: Use Railway's backup features for PostgreSQL

5. **Updates**: Keep images updated
   ```bash
   docker compose pull && docker compose up -d
   ```

## Contributing

Contributions are welcome! Areas of interest:

- New services
- Additional deployment platforms (Kubernetes, Nomad, etc.)
- Configuration improvements
- Documentation enhancements

Please read our contributing guidelines before submitting PRs.

## License

MIT License - Feel free to use, modify, and distribute.

## Resources

- [Homepage Documentation](https://gethomepage.dev/)
- [Vaultwarden Wiki](https://github.com/dani-garcia/vaultwarden/wiki)
- [Railway Documentation](https://docs.railway.app/)
- [Caddy Documentation](https://caddyserver.com/docs/)