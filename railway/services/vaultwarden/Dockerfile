# Railway Vaultwarden Service
# Uses official Vaultwarden server image with PostgreSQL support

FROM vaultwarden/server:latest

# Expose the default port
EXPOSE 80

# Environment variables expected:
# - DATABASE_URL: PostgreSQL connection string (required)
# - DOMAIN: Public URL (auto-set by Railway via RAILWAY_PUBLIC_DOMAIN)
# - ADMIN_TOKEN: Admin panel access token (recommended)
# - WEBSOCKET_ENABLED: Enable WebSocket support (set to true)

# Start the server
# The entrypoint is already configured in the base image