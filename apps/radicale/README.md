#### Environment variables

- `RADICALE_ADMIN_USERNAME`: Required bootstrap admin username.
- `RADICALE_ADMIN_PASSWORD`: Required bootstrap admin password.
- `RADICALE_BASIC_AUTH_B64`: Base64 value of `username:password` used by Caddy internal iCal bridge.
- `RADICALE_ICAL_TOKEN`: Shared token used in internal iCal bridge URL path.

#### Volumes and persistence

- Required volume mount: `/data`
- This stores users, collections, and calendars.

#### Dependencies and integrations

- Homepage calendar widget integration uses an internal Caddy bridge endpoint.
- Caddy injects Radicale Basic Auth header server-to-server.
- Homepage fetches iCal through `RADICALE_ICAL_URL` (backend only).

#### Security model

- Public endpoint (`radicale.${DOMAIN}`) remains authenticated.
- Homepage must use internal URL:
  - `http://caddy/internal/radicale-ical/<RADICALE_ICAL_TOKEN>`
- Do not expose `/internal/radicale-ical/*` on public domains.
- Do not disable Radicale authentication for convenience.
- Rotate `RADICALE_ICAL_TOKEN` and `RADICALE_BASIC_AUTH_B64` if leaked.

#### Customizations in this project

- Custom entrypoint enforces htpasswd auth and auto-creates admin user.
- Entry-point auto-creates default calendar:
  - `/<RADICALE_ADMIN_USERNAME>/default-calendar/`
- Entry-point seeds one launch-day event for first-run widget validation.
