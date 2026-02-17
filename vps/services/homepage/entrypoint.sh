#!/bin/sh

# Homepage Entrypoint for VPS
# Runs the config replacer, then starts the homepage server

echo "Starting Homepage configuration..."

# Run the TypeScript config replacer
cd /app/config-generator
node dist/index.js /app/config

# Start homepage
exec node /app/server.js