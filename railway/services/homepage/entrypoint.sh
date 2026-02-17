#!/bin/sh

# Homepage Entrypoint for Railway
# Generates services.yaml from environment variables

CONFIG_DIR="/app/config"
SERVICES_FILE="$CONFIG_DIR/services.yaml"

# Generate services.yaml from environment variable
if [ -n "$VAULTWARDEN_URL" ]; then
    # Strip any surrounding quotes from the URL (in case Railway UI added them)
    CLEAN_URL=$(echo "$VAULTWARDEN_URL" | sed 's/^"//;s/"$//')
    
    cat > "$SERVICES_FILE" << EOF
---
# My-Own-Suite Services Dashboard (Railway)

- Password Manager:
    - Vaultwarden:
        href: "$CLEAN_URL"
        description: Self-hosted password manager
        icon: vaultwarden.png
EOF
    echo "Generated services.yaml with VAULTWARDEN_URL: $CLEAN_URL"
else
    echo "Warning: VAULTWARDEN_URL not set. Using default services.yaml"
    # Create a default services.yaml if not exists
    if [ ! -f "$SERVICES_FILE" ]; then
        cat > "$SERVICES_FILE" << EOF
---
# My-Own-Suite Services Dashboard

- Password Manager:
    - Vaultwarden:
        href: https://vaultwarden.example.com
        description: Self-hosted password manager (configure VAULTWARDEN_URL)
        icon: vaultwarden.png
EOF
    fi
fi

# Start homepage
exec node /app/server.js