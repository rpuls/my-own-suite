# Radicale MOS Package

## Services

- `radicale`: the Radicale CalDAV/CardDAV server, exposed through the single public `radicale.<base-domain>` app route.
- `mcp`: the MCP server MOS offers assistants for Radicale (see AI Tools below). Built from the same pinned Radicale image (`Dockerfile.mcp`) for its Python, so it adds no image download.

Only `radicale` is routed through Caddy. `mcp` has no route; the host publishes it on loopback so Suite Manager can call it.

## Environment Variables

- `RADICALE_ADMIN_USERNAME`: Required bootstrap username for the first htpasswd user.
- `RADICALE_ADMIN_PASSWORD`: Required bootstrap password for the first htpasswd user. Suite Manager stores this as a redacted app secret and materializes it only for runtime apply.
- `RADICALE_CALENDAR_DISPLAYNAME`: Display name written to the seeded default calendar's `D:displayname` prop (falls back to `My Calendar` when unset). Applied when the collection is created, and backfilled once onto an existing collection whose props carry no displayname; a calendar the owner renamed is never touched.
- `icalToken`: Generated setup secret used in the tokenized Homepage calendar widget URL.
- `mcp` service: `RADICALE_ADMIN_USERNAME` and `RADICALE_ADMIN_PASSWORD` (the same values), plus `MOS_AI_KEY` from the generated `aiKey` setup secret. `RADICALE_URL` (default `http://radicale:5232`) and `PORT` (default `8100`) are not set by the manifest.

## Volumes And Persistence

- `data:/data`: Stores htpasswd users plus CalDAV/CardDAV collections.
- The `mcp` service mounts nothing and keeps no state. Because the Radicale image declares `/config` and `/data` as volumes, Docker still gives its container two anonymous volumes, holding only the image's default `/config/config`, which the server never reads or writes.

Disable removes the running container while leaving the route, config, secrets, and Docker volume intact. Uninstall removes the running container, route, MOS-owned Homepage shortcut, stored config/secrets, and Docker volume.

## Health Check

- `http://radicale:5232/`

The MOS app agent maps this to the package loopback port and treats an HTTP response below 500 as healthy.

## Package Behavior

- The package uses the upstream `tomsquest/docker-radicale` image pinned by digest.
- `entrypoint.sh` configures Radicale htpasswd authentication with bcrypt.
- The entrypoint creates the configured admin user when missing.
- The entrypoint refuses to start when the username starts or ends with `@`, contains more than one `@`, or contains any character of Radicale's default `minimal` blacklist (`,` `:` `'` `"` `*` `?` `` ` `` `$`). Radicale 3.9 rejects such logins and the collection paths named after them, so an install that kept one would start but lock the owner and the Homepage calendar widget out; failing at start makes the per-app update roll back instead.
- The entrypoint creates a default calendar collection at `/<RADICALE_ADMIN_USERNAME>/default-calendar/` when missing, named from `RADICALE_CALENDAR_DISPLAYNAME`. The internal iCal bridge exports exactly this collection path, so deleting and recreating the calendar under a new path breaks the Homepage widget; renaming it (a `displayname` change) is safe.
- When it creates that collection, the entrypoint also writes one all-day event (`mos-welcome.ics`) dated the install day and repeating yearly (`RRULE:FREQ=YEARLY`). The Homepage calendar widget reports a feed with zero `VEVENT`/`VTODO` items as an error, so an otherwise-empty new collection would render as a broken widget; the recurrence keeps the feed non-empty in every subsequent year too. Existing collections are never touched. This is a normal CalDAV item, so an owner who deletes it and holds no other events will see the upstream empty-feed error again.
- The manifest declares a Homepage calendar widget and a structured internal iCal bridge. Suite Manager keeps the bridge token and Radicale password redacted in public projections, then materializes them only while applying the app runtime and Homepage tile.

## AI Tools (MCP)

Radicale has no MCP server of its own, so the package ships one: [mcp-server.py](./mcp-server.py), a stateless Streamable HTTP server on port 8100 using only the Python standard library. It answers `POST /mcp` only with `Authorization: Bearer <aiKey>`, where `aiKey` is a setup secret MOS generates at install (`auth.kind: package-secret`), so the owner never handles a token. It acts as `RADICALE_ADMIN_USERNAME` with HTTP Basic auth against `http://radicale:5232`, its only connection, and sees only that user's collections. [ai-tools.json](./ai-tools.json) offers its tools by kind:

- `read`, run at See: `list_calendars` (calendars, address books, and the time zone used), `list_events` (a day range of at most 366 days, 50 events per call, optionally one calendar or matching words), `search_contacts` (name, nickname, email, phone, organisation and address; 20 at most).
- `add`, run at See and do: `add_event` writes a new single event (`If-None-Match: *`) with no `ATTENDEE` or `ORGANIZER`, to `default-calendar` unless another calendar is named.
- `change`, run at See and do: `change_event` sets the title, start and end of one event, with `If-Match` on its ETag, and leaves every other property as the client wrote it. It refuses a repeating event (`RRULE`, `RDATE` or `RECURRENCE-ID`) and an event with an `ATTENDEE`, since Radicale's email hook would notify the attendees of the change.
- No tool deletes anything, touches tasks, or changes a contact.

Repeating events come from Radicale's own CalDAV `expand`, so `EXDATE` and moved occurrences show as the owner's clients see them. Times are read and written in the `time_zone` an assistant passes, else in the calendar's `calendar-timezone`, else in the IANA zone named by most event `TZID`s in the last and next year, relearned every ten minutes; with none of those the tools say they use UTC. New and moved times are stored in UTC, all-day events as dates. A `TZID` that is not an IANA name, such as a Windows zone name, is read as the zone in use. Output is plain text, kept short for small local models.

Because the entrypoint never changes an existing user's password, a password changed in `/data/users` outside MOS stops the tools until it matches again; every call then answers with that reason.

## Current Limits

- This package creates one bootstrap Radicale user.
- MOS owner identity reuse, password rotation, show-once secret reveal, DAV auto-discovery, and multi-user client onboarding are future package-contract work.
