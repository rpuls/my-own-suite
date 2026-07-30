# Radicale MOS Package

## Environment Variables

- `RADICALE_ADMIN_USERNAME`: Required bootstrap username for the first htpasswd user.
- `RADICALE_ADMIN_PASSWORD`: Required bootstrap password for the first htpasswd user. Suite Manager stores this as a redacted app secret and materializes it only for runtime apply.
- `icalToken`: Generated setup secret used in the tokenized Homepage calendar widget URL.

## Volumes And Persistence

- `data:/data`: Stores htpasswd users plus CalDAV/CardDAV collections.

Disable removes the running container while leaving the route, config, secrets, and Docker volume intact. Uninstall removes the running container, route, MOS-owned Homepage shortcut, stored config/secrets, and Docker volume.

## Health Check

- `http://radicale:5232/`

The MOS app agent maps this to the package loopback port and treats an HTTP response below 500 as healthy.

## Package Behavior

- The package uses the upstream `tomsquest/docker-radicale` image pinned by digest.
- `entrypoint.sh` configures Radicale htpasswd authentication with bcrypt.
- The entrypoint creates the configured admin user when missing.
- The entrypoint creates a default calendar collection at `/<RADICALE_ADMIN_USERNAME>/default-calendar/` when missing.
- When it creates that collection, the entrypoint also writes one all-day event (`mos-welcome.ics`) dated the install day and repeating yearly (`RRULE:FREQ=YEARLY`). The Homepage calendar widget reports a feed with zero `VEVENT`/`VTODO` items as an error, so an otherwise-empty new collection would render as a broken widget; the recurrence keeps the feed non-empty in every subsequent year too. Existing collections are never touched. This is a normal CalDAV item, so an owner who deletes it and holds no other events will see the upstream empty-feed error again.
- The manifest declares a Homepage calendar widget and a structured internal iCal bridge. Suite Manager keeps the bridge token and Radicale password redacted in public projections, then materializes them only while applying the app runtime and Homepage tile.

## Current Limits

- This package creates one bootstrap Radicale user.
- MOS owner identity reuse, password rotation, show-once secret reveal, DAV auto-discovery, and multi-user client onboarding are future package-contract work.
