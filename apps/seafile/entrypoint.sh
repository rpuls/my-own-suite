#!/bin/sh
# Seafile Entrypoint with Admin User Initialization
# This script wraps the original Seafile entrypoint and creates the admin user

CONFIG_FILE="/shared/seafile/conf/seahub_settings.py"
ADMIN_SCRIPT="/opt/seafile/init-scripts/create_admin.py"
SEAFILE_SERVER_DIR="/opt/seafile/seafile-server-latest"

echo "Starting Seafile with admin initialization..."

# Function to create admin user
create_admin_user() {
    if [ -n "$SEAFILE_ADMIN_EMAIL" ] && [ -n "$SEAFILE_ADMIN_PASSWORD" ]; then
        echo "Checking for admin user..."
        if [ -f "$ADMIN_SCRIPT" ]; then
            # Use Seafile's python-env wrapper which sets up the proper environment
            cd "$SEAFILE_SERVER_DIR" && ./seahub.sh python-env python "$ADMIN_SCRIPT"
        else
            echo "Admin script not found: $ADMIN_SCRIPT"
        fi
    else
        echo "SEAFILE_ADMIN_EMAIL and SEAFILE_ADMIN_PASSWORD not set, skipping admin creation"
    fi
}

# Wait for Seafile to be ready (config file exists and seahub is running)
wait_for_seafile() {
    echo "Waiting for Seafile initialization..."
    while [ ! -f "$CONFIG_FILE" ]; do
        sleep 2
    done
    
    # Wait a bit more for seahub to fully start
    echo "Config file found, waiting for seahub to fully start..."
    sleep 10
}

# Run in background: wait for seafile then create admin
(
    wait_for_seafile
    create_admin_user
) &

# Execute the original Seafile entrypoint
exec /sbin/my_init -- /scripts/enterpoint.sh
