# Memos MOS Package

## Services

- `memos`: the Memos server, which also serves the web client. Single service, exposed through the public `memos.<base-domain>` app route.

There is no database or cache service. Memos keeps everything in SQLite under its data directory.

## Environment Variables

- `MEMOS_INSTANCE_URL` = `${app.publicUrl}`: the canonical external address, used for absolute links such as shared-memo links, webhooks and SSO callbacks.

The image already sets `MEMOS_PORT=5230`, which matches `internalPort`. Every other upstream default is correct for the way MOS runs the container. Two worth knowing:

- `MEMOS_CONFIG_DIR` (default `/etc/memos/config`): the declarative configuration directory, where the `Dockerfile` puts `registration.json`.
- `--trusted-proxies` (default `private`): Caddy reaches the container from a private address on the package network, so forwarded client addresses are trusted without configuration.

## Sign-Up Closed At First Start

Upstream leaves sign-up open: anyone who reaches the sign-in page can create an account. The package ships `registration.json`, a declarative configuration file Memos applies at startup, which creates the `GENERAL` instance setting with `disallowUserRegistration: true`. Its `lifecycle.ignoreChanges` releases the whole `generalSetting`, so the file only seeds the value. The owner can still change every general setting under **Settings → System**, including reopening sign-up, and a restart or update does not reset it.

With sign-up closed, `POST /api/users` from a signed-out client returns `user registration is not allowed`. An admin still adds accounts under **Settings → Member → Create Member**.

The first-run screen ("Create the administrator account") is not affected: the first person to open the app after install becomes the instance admin. That window lasts until someone opens `memos.<base-domain>`. The admin is not seeded from setup fields, because a declared user's name is fixed in the configuration file and Memos accepts only lowercase letters, digits and hyphens. A typo in an install field would then surface as a container that refuses to start, rather than as a message on the first-run screen.

## Volumes And Persistence

- `data:/var/opt/memos`: everything. It holds `memos_prod.db` (with its `-wal` and `-shm` files): notes, accounts, sessions, access tokens, instance settings and the declarative configuration state. Attachments go to the local file system by default, written under this same directory.

This single volume is the backup target. An admin can switch new attachments to the database or to S3-compatible storage under **Settings → Storage**. Existing attachments stay where they are, and S3 puts new ones outside MOS backups.

The image starts as root, `chown`s the data directory to UID/GID 10001 and drops privileges with `su-exec`.

Disable stops and removes the container while keeping the route and volume. Uninstall removes the container, route, MOS-owned Homepage shortcut and this volume.

## Health Check

- `http://memos:5230/healthz`

Returns `200` with the body `Service ready.` and needs no session.

## Outbound Network Behaviour

The server and the web client contain no analytics or crash reporting. With no memo content and nothing configured, neither contacts anything outside the server.

By default, two features follow what the owner does:

- **Link previews.** When a memo's content includes a bare link, the client asks the server (`MemoService/GetLinkMetadata`), and the server fetches that page with the user agent `MemosBot/1.0 (+https://usememos.com)` to read its title, description and image. The browser then loads the preview image from the linked site. The **Link preview** switch under **Settings → Preferences** turns it off. It is stored per browser and defaults to on.
- **Location.** Opening **Add location** calls `navigator.geolocation`; once the person allows it, the browser sends the device's coordinates to `nominatim.openstreetmap.org/reverse` straight away, and each clicked point after that. Nominatim is the OpenStreetMap Foundation's geocoder, served through Fastly.
- **Maps.** The Map view and the location picker load vector tiles, fonts and sprites from `tiles.openfreemap.org` (behind Cloudflare). If that style fails, errors, takes over 15 seconds, or WebGL is unavailable or lost, the map falls back to raster tiles from `tile.openstreetmap.org` (Fastly).
- Map and Nominatim requests carry the Memos origin in `Origin` and `Referer`; link preview images are requested without a `Referer`. A pin's popup has an **Open in Google Maps** button that opens Google Maps with the coordinates in a new tab, only when clicked.

These stay off until an admin configures them: SSO providers (GitHub, GitLab, Google and generic OAuth2 templates are built in), the AI features (OpenAI and Gemini endpoints), S3 attachment storage, captcha on sign-in (Cloudflare Turnstile or hCaptcha), and webhooks. Links in the web client to `usememos.com` and the GitHub repository are fetched only when clicked.

The sponsor memo and the sample memos compiled into the binary are only seeded with `--demo`, which this package does not set. The welcome guide on first sign-in renders its example memos locally.

## API

The `/api/v1` paths are gone since 26.10 and return `410`. REST lives under `/api/...` and Connect RPC under `/memos.api.<Service>/<Method>`. Personal access tokens are created in the web client under **Settings → Access Tokens**.

## AI Tools (MCP)

Memos serves an MCP server at `POST /mcp` (Streamable HTTP, stateless, tools only). The manifest declares it under `exports.mcp`, so the MOS AI gateway reaches it on the service's loopback port and offers assistants only the tools listed there, by kind:

- `read`, run at See: `memo_list_memos`, `memo_get_memo`, `memo_list_memo_comments`.
- `add`, run at See and do: `memo_create_memo` and `memo_create_memo_comment`, both with `body.visibility` fixed to `PRIVATE`, so a new note or comment never shares anything.
- `change`, run at See and do: `memo_update_memo`, with `updateMask` fixed to `content`, so an edit changes the text and never who can see the note. Memos keeps no earlier versions, so an edit cannot be undone.
- `destructive`, never offered: `memo_delete_memo`, `attachment_delete_attachment`. Deletes are permanent; Memos has no archive for them.
- Every other tool Memos advertises (spaces, reactions, relations, attachments, sharing) is not listed and is never offered.

The gateway calls Memos with a personal access token the owner creates under Memos **Settings → Access Tokens** (`auth.tokenPage` links there) and pastes into MOS the first time Memos is opened to an AI; it is replaced or removed on the Memos app page, and stored as `ai-token.secret` in the instance's secret directory. A token with an expiry stops every AI from using Memos once it lapses, so the hint asks for none. A Memos token has no scopes: it carries its user's full power, including instance settings and minting more tokens, so the gateway's tool list is the only boundary. A separate least-privileged Memos user cannot stand in for the owner, because it never sees the owner's private memos, which is what new memos are by default. MOS checks a pasted token with `auth_get_current_user` before saving it. Revoking the token in Memos takes effect on the next call.

Tool results return memo text verbatim, so a memo can carry instructions aimed at an AI; any signed-in user can plant such text in a protected memo another user's AI reads. The gateway wraps results as untrusted data, and the kinds and fixed arguments bound what any such instruction can reach. The owner's token belongs to the Memos admin, which can edit any memo it can name, including another household member's protected memos.

## Upgrades

Memos runs its SQLite migrations on start, hence `backupRequired: true` and brief downtime. A database migrated by a newer version is not guaranteed to open on an older one, so `rollback: safe` refers to the container, not to reversing a migration.

## Import And Export

**Settings → Export & Import** exports every memo a user created, with comments, archived memos and attachments, as one ZIP in Memos Export Format: a Markdown file and a JSON record per memo. Importing keeps memo identifiers, so importing the same file twice does not duplicate. Keep that export alongside MOS volume backups as the portable copy.
