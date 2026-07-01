# Radicale V2 Package

## Environment Variables

- `RADICALE_ADMIN_USERNAME`: Required bootstrap username for the first htpasswd user.
- `RADICALE_ADMIN_PASSWORD`: Required bootstrap password for the first htpasswd user. Suite Manager stores this as a redacted app secret and materializes it only for runtime apply.

## Volumes And Persistence

- `data:/data`: Stores htpasswd users plus CalDAV/CardDAV collections.

Disable and preserved-data uninstall remove the running container and route while leaving this Docker volume intact.

## Health Check

- `http://radicale:5232/`

The V2 app agent maps this to the package loopback port and treats an HTTP response below 500 as healthy.

## Package Behavior

- The package uses the upstream `tomsquest/docker-radicale` image pinned by digest.
- `entrypoint.sh` configures Radicale htpasswd authentication with bcrypt.
- The entrypoint creates the configured admin user when missing.
- The entrypoint creates a default calendar collection at `/<RADICALE_ADMIN_USERNAME>/default-calendar/` when missing.

## Current Limits

- This first V2 package slice creates one bootstrap Radicale user.
- MOS owner identity reuse, password rotation, show-once secret reveal, DAV auto-discovery, and Homepage calendar widget integration are future package-contract work.
