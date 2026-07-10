# Radicale V2 Package

## Environment Variables

- `RADICALE_ADMIN_USERNAME`: Required bootstrap username for the first htpasswd user.
- `RADICALE_ADMIN_PASSWORD`: Required bootstrap password for the first htpasswd user. Suite Manager stores this as a redacted app secret and materializes it only for runtime apply.
- `icalToken`: Generated setup secret used in the tokenized Homepage calendar widget URL.

## Volumes And Persistence

- `data:/data`: Stores htpasswd users plus CalDAV/CardDAV collections.

Disable removes the running container while leaving the route, config, secrets, and Docker volume intact. Uninstall removes the running container, route, MOS-owned Homepage shortcut, stored config/secrets, and Docker volume.

## Health Check

- `http://radicale:5232/`

The V2 app agent maps this to the package loopback port and treats an HTTP response below 500 as healthy.

## Package Behavior

- The package uses the upstream `tomsquest/docker-radicale` image pinned by digest.
- `entrypoint.sh` configures Radicale htpasswd authentication with bcrypt.
- The entrypoint creates the configured admin user when missing.
- The entrypoint creates a default calendar collection at `/<RADICALE_ADMIN_USERNAME>/default-calendar/` when missing.
- The manifest declares a Homepage calendar widget and a structured internal iCal bridge. Suite Manager keeps the bridge token and Radicale password redacted in public projections, then materializes them only while applying the app runtime and Homepage tile.

## Current Limits

- This first V2 package slice creates one bootstrap Radicale user.
- MOS owner identity reuse, password rotation, show-once secret reveal, DAV auto-discovery, and multi-user client onboarding are future package-contract work.
