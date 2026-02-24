# Vaultwarden

Self-hosted Bitwarden-compatible password manager.

## Customizations in this project

- VPS deployment uses the official Vaultwarden image directly.
- A lightweight Dockerfile is kept for platform deployment workflows.

## Environment variables

- `DATABASE_URL`: Database connection string (required for platform deployments).
- `DOMAIN`: Public URL used by Vaultwarden.
- `ADMIN_TOKEN`: Token for admin panel access.
- `WEBSOCKET_ENABLED`: Enables websocket notifications.
- `ROCKET_PORT` / `PORT`: Runtime port binding (platform-dependent).

## Official website

- https://github.com/dani-garcia/vaultwarden
