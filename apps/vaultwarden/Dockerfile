# Vaultwarden Service (Platform Deployments)
# Uses official Vaultwarden server image with PostgreSQL support
# For VPS deployments, the official image is used directly in docker-compose

FROM vaultwarden/server@sha256:d626d04934cd1192ad8ced1adb975099fca78cec33ab467d2d3c923cde7f3b0c

COPY --chmod=755 entrypoint.sh /mos-vaultwarden-entrypoint.sh

# Platform deployments (Railway, Dokploy) provide PORT environment variable
# Vaultwarden/Rocket will automatically use PORT if set

# Environment variables expected:
# - DATABASE_URL: PostgreSQL connection string (required for platform)
# - DOMAIN: Public URL
# - ADMIN_TOKEN: Admin panel access token (recommended)
# - WEBSOCKET_ENABLED: Enable WebSocket support (set to true)
# - PORT: Set automatically by platform (do not override)

# Start the server
# Keep the base image entrypoint and run a MOS wrapper before upstream start.sh.
CMD ["/mos-vaultwarden-entrypoint.sh"]
