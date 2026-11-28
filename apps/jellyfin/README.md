# Jellyfin MOS Package

## Environment Variables

- `JELLYFIN_PUBLISHEDSERVERURL`: Projected from the app public URL, so clients that discover the server are told its HTTPS address. .NET reads Jellyfin's settings case-insensitively, which is why the upper-case name the manifest requires still applies.
- `MOS_ADMIN_NAME`, `MOS_ADMIN_PASSWORD`: The administrator the package creates on first start, from the two setup fields. The password field is marked `forgetAfterStart`, so `MOS_ADMIN_PASSWORD` is set only until a start first passes the health check; every later start runs without it and uses the API key instead.
- `MOS_LIBRARIES`: The libraries the package creates, as `Name|collection type|container path` entries separated by `;`. Each must match a folder under `storage` in the manifest.

## Volumes And Persistence

- `config:/config`: Server configuration, the library database, users and watch history. Backed up with the suite.
- `cache:/cache`: Transcodes and image cache. Rebuilt on demand.

Disable preserves these volumes. Uninstall removes them; the films on the drive are never touched.

## Folders On The Owner's Drive

The manifest declares two folders under `storage`, required, so MOS refuses the install until the server has a drive formatted as exFAT, NTFS or FAT32. On install MOS creates `MOS-files/apps/jellyfin/Movies` and `MOS-files/apps/jellyfin/Series` on the drive the owner picks and mounts them read-only at `/media/movies` and `/media/series`. They are not app volumes: the suite backup does not include them and uninstall leaves them on the drive.

Because the mounts are read-only, every library is created with `SaveLocalMetadata`, `SaveSubtitlesWithMedia`, `SaveLyricsWithMedia` and `SaveTrickplayWithMedia` off, so Jellyfin never tries to write beside the media.

## First Start

Jellyfin creates its administrator and libraries only through its API, against `http://127.0.0.1:8096`. MOS restarts the container and forgets the password as soon as the health check passes, so when `/config/mos-api-key` is missing and `MOS_ADMIN_PASSWORD` is set, `entrypoint.sh` first runs a private start that the health check cannot reach:

1. Sets `LocalNetworkAddresses` in `network.xml` to `127.0.0.1`, so Jellyfin listens on the container's loopback only, and starts it.
2. Waits for `/System/Info/Public`, which answers only once the API is up (`/health` answers earlier).
3. If `StartupWizardCompleted` is false, finishes the wizard with `MOS_ADMIN_NAME` and `MOS_ADMIN_PASSWORD`.
4. Signs in and creates an API key named `MOS`, kept in `/config/mos-api-key` (mode 0600), so later starts work without the password, also after the owner changes it.
5. Stops that server and sets `LocalNetworkAddresses` back to empty. Every start also clears a loopback-only binding an interrupted private start left behind.

If the wizard cannot be finished, the container exits instead of offering an unclaimed wizard, so health never passes and MOS keeps the password for the next attempt. If only the key fails, as on an existing server whose password has changed, the wrapper logs it and starts Jellyfin without managing libraries. A start with neither the key nor the password logs one `MOS:` line and does the same.

Jellyfin then starts on the network, and a background job uses the key to:

1. Add a library for each `MOS_LIBRARIES` entry whose path is mounted and not yet a library, with realtime monitoring on.
2. Call `POST /Library/Refresh` on every start. MOS restarts the container when the drive is plugged back in, so files copied onto it elsewhere are found then; while the drive is attached, Jellyfin's file watcher picks up changes itself.

A failed library step is logged with a `MOS:` prefix and retried at the next start; it never holds the server back.

Before the server starts, the wrapper also sets `KnownProxies` in `/config/config/network.xml` to the container's gateway, where Caddy's requests arrive, so Jellyfin takes the visitor's address from `X-Forwarded-For` and a user's "Allow remote connections" setting works. It rewrites that entry on every start because the gateway changes with the network. On first start it also sets `LocalNetworkSubnets` to the private ranges; the owner can change them afterwards in the dashboard. Jellyfin reads this file only at start.

## Health Check

- `http://jellyfin:8096/health`

## Transcoding

MOS grants containers no device access, so there is no hardware acceleration: transcoding runs on the CPU with the bundled `jellyfin-ffmpeg`. Clients that play the file directly use no CPU for it.
