# Navidrome MOS Package

## Environment variables

- `MOS_ADMIN_NAME`, `MOS_ADMIN_PASSWORD`: Administrator credentials from install. The wrapper creates the account through `/auth/createAdmin` while Navidrome listens only on loopback, then restarts it on the container network. Existing accounts are never reset; later changes belong in Navidrome.
- `ND_DATAFOLDER=/data`, `ND_MUSICFOLDER=/music`: Database/cache and read-only music library.
- `ND_SCANNER_SCHEDULE=@every 1m`: Finds files uploaded through MOS; startup scanning also finds files copied while the drive was disconnected.
- `ND_ENABLEINSIGHTSCOLLECTOR=false`: Disables anonymous usage reporting.
- `ND_ENABLEGRAVATAR=false`: Disables external avatar URLs and Gravatar redirects.
- `ND_GATRACKINGID` is empty: No Google Analytics tracking ID is supplied. These manifest-owned settings cannot be replaced through the MOS environment editor.
- `ND_UILOGINBACKGROUNDURL`: The shared MOS wallpaper SVG, embedded as a data URL by `npm run branding:sync`. This prevents creation of the remote-background handler and avoids its startup image-list fetch.
- `MOS_ONLINE_METADATA`: Boolean install choice, enabled by default. When false, the wrapper sets `ND_AGENTS` to an empty string so only local metadata is used. It does not disable Last.fm or ListenBrainz scrobbling. An explicit owner-set `ND_AGENTS` takes precedence over this initial choice.

MOS disables known optional telemetry where the packaged app provides a supported setting. External music integrations and plugins retain upstream defaults. Navidrome ignores empty environment values, so the package supplies no configuration file with a Google Analytics tracking ID either; this is not a network firewall against manually modified configurations.

The metadata checkbox is an install-time setup field; MOS displays setup values as facts after installation. An owner who later changes the metadata agents can set `ND_AGENTS` through the existing environment editor. Empty selects local metadata only; `deezer,lastfm,listenbrainz` restores the upstream agent list.

ListenBrainz scrobbling requires the user to enable it in Personal Settings and provide a user token. The same service can also answer metadata requests without that token when included in `ND_AGENTS`; metadata lookup and listening-history sharing are separate behaviours. Last.fm scrobbling additionally requires server API credentials (`ND_LASTFM_APIKEY`, `ND_LASTFM_SECRET`) and the user's account authorisation.

## Persistence and backups

`data:/data` holds the SQLite database, users, playlists, favourites, listening history, uploaded artwork and caches. MOS backs up this named volume with the service stopped for consistency. Updates require a backup because database migrations may prevent downgrading.

The required `Music` storage folder is created at `MOS-files/apps/navidrome/Music` on the selected drive and mounted read-only at `/music`. MOS 0.23.0 or later is required. Music files are outside suite backups and remain on the drive after uninstall; the data volume is removed on uninstall. Keep a separate copy of the music.

The package uses the upstream image's root user to create its named-volume data. Music is read-only, and no host devices, extra ports or privileges are granted. The bundled FFmpeg handles CPU transcoding for clients that cannot play an original format.

## Health check

`http://navidrome:4533/ping` returns HTTP 200 when the server answers. During initial account creation it is reachable only inside the container, so MOS cannot report the app ready before setup succeeds.

## Operations

After adding files through MOS's drive browser, allow one minute for scanning. For music copied with the drive attached to another computer, eject it through MOS first; reconnecting starts Navidrome and scans again. Tags determine album and artist grouping; embedded artwork and local cover files work without online lookups.

Administrator provisioning failures stop the container with an error rather than exposing an unclaimed first-run account. Credentials set in Suite Manager are initial credentials; change an existing account's password inside Navidrome.
