#!/bin/sh

# Homepage Entrypoint
# Seeds local icons, runs the config generator, then starts the homepage server

echo "Starting Homepage configuration..."

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
node dist/index.js /app/config

# Start homepage
exec node /app/server.js
