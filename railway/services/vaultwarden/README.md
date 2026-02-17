# Vaultwarden

Self-hosted Bitwarden-compatible password manager.

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string
- `DOMAIN` - Public URL
- `ADMIN_TOKEN` - Admin panel access token
- `WEBSOCKET_ENABLED` - Enable WebSocket (`true`)
- `ROCKET_PORT` - **Must be set to `${{PORT}}`** (Railway requirement)