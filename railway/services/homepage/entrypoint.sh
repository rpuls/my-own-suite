#!/bin/sh

# Homepage Entrypoint for Railway
# Runs the config generator, then starts the homepage server

echo "Starting Homepage configuration..."

# Run the TypeScript config generator
cd /app/config-generator
node dist/index.js /app/config

# Start homepage
exec node /app/server.js