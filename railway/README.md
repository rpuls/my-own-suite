# My-Own-Suite Railway Deployment

This directory contains Railway-specific service configurations for deploying My-Own-Suite to [Railway](https://railway.app/).

## Architecture

Railway uses a service-per-folder model where each service is deployed independently. Railway handles:
- HTTPS/TLS termination
- Public domain routing
- Automatic scaling
- Container orchestration

```
┌─────────────────────────────────────────────────────────┐
│                  Railway Deployment                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌─────────────┐           ┌─────────────────────┐    │
│   │  Homepage   │           │     Vaultwarden     │    │
│   │  :3000      │           │        :80          │    │
│   │             │           │                     │    │
│   │ VAULTWARDEN_│──────────▶│    PostgreSQL      │    │
│   │    URL      │           │    (separate svc)  │    │
│   └─────────────┘           └─────────────────────┘    │
│                                                         │
│   Each service gets its own public domain               │
│   Railway handles HTTPS automatically                    │
└─────────────────────────────────────────────────────────┘
```

## Services

| Service | Directory | Description |
|---------|-----------|-------------|
| Homepage | `services/homepage/` | Dashboard linking to all services |
| Vaultwarden | `services/vaultwarden/` | Password manager |

## Deployment Guide

### Prerequisites

1. A Railway account ([sign up](https://railway.app/))
2. A GitHub repository with this code (fork or clone)
3. Railway connected to your GitHub account

### Step 1: Create a New Project

1. Go to [Railway Dashboard](https://railway.app/dashboard)
2. Click **+ New Project**
3. Select **Empty Project**

### Step 2: Deploy PostgreSQL

Vaultwarden requires a PostgreSQL database:

1. In your project, click **+ New**
2. Select **Database** → **PostgreSQL**
3. Wait for provisioning to complete
4. Note the service name (default: `postgres`)

### Step 3: Deploy Vaultwarden

1. Click **+ New** → **GitHub Repo**
2. Select your repository
3. Configure the service:
   - **Root Directory**: `railway/services/vaultwarden`
4. Railway will detect `railway.json` automatically
5. Set environment variables:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
DOMAIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
ADMIN_TOKEN=your-secure-token-here
WEBSOCKET_ENABLED=true
```

6. Go to **Settings** → **Networking** → **Generate Domain**
7. Update `DOMAIN` to match the generated URL

### Step 4: Deploy Homepage

1. Click **+ New** → **GitHub Repo**
2. Select your repository
3. Configure the service:
   - **Root Directory**: `railway/services/homepage`
4. Set environment variables:

```env
VAULTWARDEN_URL=https://your-vaultwarden-domain.railway.app
```

Replace the URL with your actual Vaultwarden domain from Step 3.

5. Go to **Settings** → **Networking** → **Generate Domain**

### Step 5: Verify Deployment

- Access Homepage at its generated domain
- Click the Vaultwarden link to verify connectivity
- Create your Vaultwarden account

## Environment Variables Reference

### Vaultwarden

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Yes | `${{Postgres.DATABASE_URL}}` |
| `DOMAIN` | Public URL | Yes | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `ADMIN_TOKEN` | Admin panel access | Recommended | Random 48-char string |
| `WEBSOCKET_ENABLED` | Enable WebSocket sync | Yes | `true` |
| `SIGNUPS_ALLOWED` | Allow new accounts | Optional | `false` (after setup) |

### Homepage

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `VAULTWARDEN_URL` | URL to Vaultwarden | Yes | `https://vw.up.railway.app` |

## Railway-Specific Features

### Auto-Generated Domains

Railway provides:
- `${{RAILWAY_PUBLIC_DOMAIN}}` - Auto-populated public domain
- Automatic HTTPS via Railway's infrastructure
- No need for Caddy or manual SSL certificates

### Variable References

Use Railway's variable references to connect services:
- `${{Postgres.DATABASE_URL}}` - Reference PostgreSQL connection
- `${{ServiceName.RAILWAY_PUBLIC_DOMAIN}}` - Reference another service's domain

### Resource Management

Each service can be scaled independently:
- Adjust CPU/memory in Railway dashboard
- Set up auto-scaling rules if needed
- Monitor resource usage per service

## Cost Considerations

Railway charges based on resource usage:
- PostgreSQL: ~$5/month for basic usage
- Each service: ~$1-5/month depending on traffic
- Free tier available for development/testing

## Troubleshooting

### Service Won't Start

1. Check **Deployments** tab for logs
2. Verify all required environment variables are set
3. Ensure PostgreSQL is connected and healthy

### Can't Connect to Vaultwarden

1. Verify `DOMAIN` matches your Railway domain
2. Check that `DATABASE_URL` is correctly set
3. Review Vaultwarden logs for errors

### Homepage Shows Wrong Links

1. Update `VAULTWARDEN_URL` environment variable
2. Redeploy the Homepage service

## Additional Resources

- [Railway Documentation](https://docs.railway.app/)
- [Railway Variable References](https://docs.railway.app/develop/variables#referencing-another-services-variable)
- [Vaultwarden Wiki](https://github.com/dani-garcia/vaultwarden/wiki)
- [Homepage Documentation](https://gethomepage.dev/)