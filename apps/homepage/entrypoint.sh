#!/bin/sh

# Homepage Entrypoint
# Seeds runtime config and local icons, runs the config generator, then starts
# the homepage server.

echo "Starting Homepage configuration..."

DEFAULT_CONFIG_DIR="${HOMEPAGE_DEFAULT_CONFIG_DIR:-/app/default-config}"
RUNTIME_CONFIG_DIR="${HOMEPAGE_CONFIG_DIR:-/app/config}"

CONFIG_FILES="
bookmarks.yaml
widgets.yaml
settings.yaml
custom.css
custom.js
docker.yaml
kubernetes.yaml
services.template.yaml
"

mkdir -p "$RUNTIME_CONFIG_DIR"

if [ "${HOMEPAGE_RESET_TO_DEFAULT:-}" = "1" ] || [ "${HOMEPAGE_RESET_TO_DEFAULT:-}" = "true" ]; then
  echo "Resetting Homepage runtime config from repo defaults..."
  for file in $CONFIG_FILES; do
    if [ -f "$DEFAULT_CONFIG_DIR/$file" ]; then
      cp "$DEFAULT_CONFIG_DIR/$file" "$RUNTIME_CONFIG_DIR/$file"
    fi
  done
  rm -f "$RUNTIME_CONFIG_DIR/services.yaml"
else
  echo "Seeding missing Homepage runtime config files..."
  for file in $CONFIG_FILES; do
    if [ -f "$DEFAULT_CONFIG_DIR/$file" ] && [ ! -f "$RUNTIME_CONFIG_DIR/$file" ]; then
      cp "$DEFAULT_CONFIG_DIR/$file" "$RUNTIME_CONFIG_DIR/$file"
    fi
  done
fi

# Seed privacy-safe local icons into the writable images volume.
mkdir -p /app/public/images
if [ -d /app/icon-seed ]; then
  for icon in /app/icon-seed/*; do
    [ -f "$icon" ] || continue
    target="/app/public/images/$(basename "$icon")"
    if [ ! -f "$target" ]; then
      cp "$icon" "$target"
    fi
  done
fi

# Run the TypeScript config generator
cd /app/config-generator || exit 1
node dist/index.js "$RUNTIME_CONFIG_DIR"

# Start homepage
exec node /app/server.js
