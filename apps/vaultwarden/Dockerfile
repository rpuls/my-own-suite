# Vaultwarden Service (Platform Deployments)
# Uses official Vaultwarden server image with PostgreSQL support
# For VPS deployments, the official image is used directly in docker-compose

FROM vaultwarden/server@sha256:c4f6056fe0c288a052a223cecd263a90d1dda1a0177bb5b054a363a6c7b211d9

# Platform deployments (Railway, Dokploy) provide PORT environment variable
# Vaultwarden/Rocket will automatically use PORT if set

# Environment variables expected:
# - DATABASE_URL: PostgreSQL connection string (required for platform)
# - DOMAIN: Public URL
# - ADMIN_TOKEN: Admin panel access token (recommended)
# - WEBSOCKET_ENABLED: Enable WebSocket support (set to true)
# - PORT: Set automatically by platform (do not override)

# Start the server
# The entrypoint is already configured in the base image
