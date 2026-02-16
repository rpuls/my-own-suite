# Vaultwarden - Railway Deployment

Self-hosted Bitwarden-compatible password manager deployed on Railway.

## Requirements

This service requires a PostgreSQL database. You must create one in Railway before deploying.

## Deployment Steps

### 1. Create PostgreSQL Database

In your Railway project:
1. Click **+ New**
2. Select **Database** → **PostgreSQL**
3. Note the database name (e.g., `postgres`)

### 2. Deploy Vaultwarden Service

1. Click **+ New** → **GitHub Repo**
2. Select your fork of `my-own-suite`
3. Set **Root Directory** to: `railway/services/vaultwarden`
4. Railway will automatically detect the `railway.json` configuration

### 3. Configure Environment Variables

Set the following environment variables in the Vaultwarden service:

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `DOMAIN` | Public URL of your Vaultwarden instance | Yes |
| `ADMIN_TOKEN` | Secure token for admin panel access | Recommended |
| `WEBSOCKET_ENABLED` | Enable WebSocket for real-time sync | `true` |

**Note:** Railway automatically provides `DATABASE_URL` when you connect the PostgreSQL service. You can reference it using `${{Postgres.DATABASE_URL}}`.

**Note:** `DOMAIN` should be set to your public Railway URL. Railway provides `RAILWAY_PUBLIC_DOMAIN` which you can use: `https://${{RAILWAY_PUBLIC_DOMAIN}}`

### 4. Connect Database

In Railway:
1. Open your Vaultwarden service
2. Go to **Variables** tab
3. Add a reference to PostgreSQL: `${{Postgres.DATABASE_URL}}`

### 5. Generate Domain

1. Go to **Settings** tab in your Vaultwarden service
2. Click **Generate Domain** to get a public URL
3. Update `DOMAIN` variable to match the generated URL

## Environment Variable Reference

```env
# Database connection (auto-provided by Railway when connected)
DATABASE_URL=${{Postgres.DATABASE_URL}}

# Your public Vaultwarden URL
DOMAIN=https://${{RAILWAY_PUBLIC_DOMAIN}}

# Admin panel security
ADMIN_TOKEN=your-secure-random-token-here

# Enable WebSocket for real-time sync
WEBSOCKET_ENABLED=true

# Optional: Disable signups after creating your account
SIGNUPS_ALLOWED=false
```

## Security Recommendations

1. **Set a strong `ADMIN_TOKEN`**: Use a long, random string
   ```bash
   openssl rand -base64 48
   ```

2. **Disable signups**: After creating your account, set `SIGNUPS_ALLOWED=false`

3. **Use HTTPS**: Railway provides automatic HTTPS

## Access

After deployment:
- **Main UI**: `https://your-domain.railway.app/`
- **Admin Panel**: `https://your-domain.railway.app/admin` (requires ADMIN_TOKEN)

## Resources

- [Vaultwarden Documentation](https://github.com/dani-garcia/vaultwarden/wiki)
- [Vaultwarden Docker Image](https://hub.docker.com/r/vaultwarden/server)
- [Railway Documentation](https://docs.railway.app/)