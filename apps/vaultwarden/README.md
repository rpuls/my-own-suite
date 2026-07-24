# Vaultwarden MOS Package

## Environment Variables

- `ADMIN_TOKEN`: Admin-panel token, projected from the generated `adminToken` setup secret. Suite Manager state keeps only a secret reference, redacted label, and fingerprint.
- `DOMAIN`: Projected from the app public URL.
- `SIGNUPS_ALLOWED=true`: The server accepts new account registrations.
- `WEBSOCKET_ENABLED=true`: Live sync notifications for connected clients.

## Volumes And Persistence

- `data:/data`: Stores the SQLite database and all other server state. Vault data is encrypted by the Bitwarden clients before it reaches the server.

The package runs Vaultwarden as a single service on its built-in SQLite storage; there is no separate database container. The self-hosted server requires no upstream Bitwarden account.

## Health Check

- `http://vaultwarden:80/alive`

## Secret Handling

The `adminToken` setup field is generated at logical install time and stored as a restricted secret file. Suite Manager must not return the raw admin token in package listings, install responses, logs, or projection previews. Runtime apply resolves the secret only from the configured MOS app secret directory; if the secret file is missing, unreadable, or outside that directory, Suite Manager fails closed with a controlled `APP_SECRET_UNAVAILABLE` lifecycle error without calling the app agent or exposing the secret path.

## Current Limits

- There is no owner-facing admin-token reveal or rotation flow yet.
- A richer package variant could introduce PostgreSQL; the current package intentionally stays on single-service SQLite.
