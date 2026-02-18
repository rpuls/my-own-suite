# My-Own-Suite

**Own your data. Own your tools. Own your stack.**

My-Own-Suite is the **Swiss Army knife of self-hosted open-source software** — a carefully curated suite of open-source alternatives to common SaaS products, bundled together and deployable with minimal effort.

It's designed for people who want the convenience of modern SaaS **without giving up control, privacy, or digital sovereignty**.

---

## What is My-Own-Suite?

Most people don't want to become system administrators — they just want tools that work.

My-Own-Suite bridges that gap.

It provides a **ready-made personal SaaS stack**: password management, file storage, documents, photos, identity, and more — all running on infrastructure **you control**, whether that's a VPS, Railway, or another cloud provider.

Think of it as:

- 🧰 A **Swiss Army knife**: many tools, one cohesive system
- 🔓 An **exit hatch from Big Tech SaaS**
- 🏠 A **personal cloud**, not someone else's product

You can deploy everything at once, extend it gradually, and migrate between platforms without redesigning your setup.

---

## Included Services

| Service | Description | Status |
|------|-------------|--------|
| [Homepage](https://gethomepage.dev/) | Clean, modern dashboard for all services | ✅ Ready |
| [Vaultwarden](https://github.com/dani-garcia/vaultwarden) | Bitwarden-compatible password manager | ✅ Ready |

---

## Planned Services

The roadmap focuses on replacing common proprietary SaaS categories with best-in-class open source alternatives:

- **Nextcloud** — File sync & collaboration
- **Immich** — Photo backup & management
- **Paperless-ngx** — Document archive & OCR
- **Authentik** — Identity & single sign-on
- **OnlyOffice** — Document editing

The goal is not "everything" — it's **the right tools, integrated well**.

---

## Deployment Options

My-Own-Suite is built as a **single monorepo** with **first-class support for multiple deployment targets** — no hacks, no forks.

| Platform | Directory | Best For |
|--------|-----------|----------|
| VPS / Docker Compose | `/deploy/vps` | Full control, private servers |
| Railway | Deploy template | One-click deploy, managed infrastructure |
| Dokploy | Deploy template | Self-hosted PaaS, managed infrastructure |

All deployments share the same application source from `/apps`, ensuring identical behavior across platforms.

---

## VPS Deployment

Best for full self-hosting on providers like Hetzner, DigitalOcean, or a home server.

```bash
cd deploy/vps
chmod +x scripts/install.sh
./scripts/install.sh
```

**Features:**
- Docker Compose orchestration
- Caddy reverse proxy with automatic HTTPS
- All services on a single domain
- Full control over networking

👉 [See VPS Documentation](./deploy/vps/README.md)

### Platform Deployment

**Railway** — Deploy template coming soon!

**Dokploy** — Deploy template coming soon!

**Features:**
- One-click deployment
- Automatic HTTPS
- Independent scaling per service
- No server management

## Architecture

```
my-own-suite/
├── README.md                 # This file
├── .env.example              # Environment template
├── .gitignore
├── apps/                     # Shared applications (single source of truth)
│   ├── homepage/
│   │   ├── Dockerfile
│   │   ├── entrypoint.sh
│   │   ├── config/           # Dashboard configuration
│   │   └── config-generator/ # TypeScript config generator
│   └── vaultwarden/
│       ├── Dockerfile        # Platform-optimized (PostgreSQL support)
│       └── README.md
└── deploy/                   # Deployment configurations
    └── vps/                  # VPS/Docker Compose deployment
        ├── docker-compose.yml
        ├── Caddyfile
        ├── .env.example
        └── scripts/
            └── install.sh
```

### Why This Structure?

- **`/apps`** — Contains all application code, shared across all deployment platforms
- **`/deploy`** — Platform-specific configuration (docker-compose, Caddyfile, etc.)
- **Single source of truth** — Both VPS and platform deployments use the same `/apps` code
- **No duplication** — Fix a bug in homepage, it's fixed everywhere

## Philosophy

### Monorepo Approach

My-Own-Suite uses a monorepo structure to keep all deployment options in sync:

- **Single source of truth** - One repository, multiple deployment targets
- **Shared applications** - All platforms build from `/apps`
- **Platform independence** - Each platform's specifics isolated in `/deploy`
- **Future-proof** - Add new platforms without restructuring

### Design Principles

1. **Minimal complexity** - No unnecessary abstractions or tooling
2. **Environment-based config** - No hardcoded domains or secrets
3. **Production-ready** - Security best practices out of the box
4. **Extensible** - Easy to add new services or platforms

## Quick Start

### Prerequisites

- Docker and Docker Compose (for VPS)
- A domain name (recommended)

### VPS Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/my-own-suite.git
cd my-own-suite

# Configure
cp .env.example deploy/vps/.env
# Edit deploy/vps/.env with your domain and settings

# Deploy
cd deploy/vps
docker compose up -d
```

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
   - Railway/Dokploy: Automatic HTTPS

4. **Backups**: Regularly backup your data volumes
   - VPS: Docker named volumes managed by compose

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
- [Dokploy Documentation](https://docs.dokploy.com/)
- [Caddy Documentation](https://caddyserver.com/docs/)