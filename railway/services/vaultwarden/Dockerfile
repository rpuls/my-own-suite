# Railway Vaultwarden Service
# Uses official Vaultwarden server image with PostgreSQL support

FROM vaultwarden/server:latest

# Railway provides PORT environment variable which the app must bind to
# Vaultwarden/Rocket will automatically use PORT if set
# No EXPOSE needed - Railway handles this automatically

# Environment variables expected:
# - DATABASE_URL: PostgreSQL connection string (required)
# - DOMAIN: Public URL (auto-set by Railway via RAILWAY_PUBLIC_DOMAIN)
# - ADMIN_TOKEN: Admin panel access token (recommended)
# - WEBSOCKET_ENABLED: Enable WebSocket support (set to true)
# - PORT: Set automatically by Railway (do not override)

# Start the server
# The entrypoint is already configured in the base image
