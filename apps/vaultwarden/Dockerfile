# Vaultwarden Service (Platform Deployments)
# Uses official Vaultwarden server image with PostgreSQL support
# For VPS deployments, the official image is used directly in docker-compose

FROM vaultwarden/server@sha256:43498a94b22f9563f2a94b53760ab3e710eefc0d0cac2efda4b12b9eb8690664

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
