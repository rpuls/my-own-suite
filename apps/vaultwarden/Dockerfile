# Vaultwarden Service (Platform Deployments)
# Uses official Vaultwarden server image with PostgreSQL support
# For VPS deployments, the official image is used directly in docker-compose

FROM vaultwarden/server@sha256:9a8eec71f4a52411cc43edc7a50f33e9b6f62b5baca0dd95f0c6e7fd60f1a341

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
