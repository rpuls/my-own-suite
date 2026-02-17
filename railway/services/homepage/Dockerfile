# Railway Homepage Service
# Custom build that generates config from environment variables

FROM ghcr.io/gethomepage/homepage:latest

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create config directory
RUN mkdir -p /app/config

# Copy static config files
COPY config/ /app/config/

# Expose the default port
EXPOSE 3000

# Use custom entrypoint
ENTRYPOINT ["/entrypoint.sh"]