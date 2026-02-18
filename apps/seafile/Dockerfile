# Seafile Service (Platform Deployments)
# Uses official Seafile Community Edition image with custom initialization

FROM seafileltd/seafile-mc:11.0-latest

# Copy admin initialization scripts
COPY init-scripts/ /opt/seafile/init-scripts/
COPY entrypoint.sh /opt/seafile/entrypoint.sh

# Make scripts executable
RUN chmod +x /opt/seafile/entrypoint.sh /opt/seafile/init-scripts/*.py

# Platform deployments (Railway, Dokploy) provide PORT environment variable
# Seafile will automatically use PORT if set

# Environment variables expected:
# - DB_HOST: MySQL host (required)
# - DB_ROOT_PASSWD: MySQL root password (required)
# - SEAFILE_SERVER_HOSTNAME: Public hostname
# - SEAFILE_ADMIN_EMAIL: Admin email (auto-created if set)
# - SEAFILE_ADMIN_PASSWORD: Admin password (auto-created if set)
# - TIME_ZONE: Timezone (optional, default UTC)

# Use custom entrypoint for admin user initialization
ENTRYPOINT ["/opt/seafile/entrypoint.sh"]
