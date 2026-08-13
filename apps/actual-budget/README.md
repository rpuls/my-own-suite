# Actual Budget MOS Package

## Services

- `actual`: the Actual sync server, which also serves the web client. Single service, exposed through the public `actual.<base-domain>` app route.

There is no database or cache service. The sync server keeps its account database, sessions and budget files as SQLite files under one data directory.

## Environment Variables

The package sets none. Every upstream default is correct for the way MOS runs the container, and the values worth knowing are:

- `ACTUAL_PORT` (default `5006`): matches `internalPort`.
- `ACTUAL_DATA_DIR` (default `/data`): parent of everything persistent; the volume is mounted here.
- `ACTUAL_SERVER_FILES` (default `/data/server-files`), `ACTUAL_USER_FILES` (default `/data/user-files`): both inside the mounted volume, so neither needs overriding.
- `ACTUAL_TRUSTED_PROXIES` (default: private and loopback ranges): Caddy reaches the container over the package-owned Docker network from a private address, so the default already covers it.
- `ACTUAL_LOGIN_METHOD` (default `password`): the server prompts for a password on first open. `openid` and `header` are upstream options this package does not configure.
- `ACTUAL_UPLOAD_FILE_SYNC_SIZE_LIMIT_MB` (default 20), `ACTUAL_UPLOAD_SYNC_ENCRYPTED_FILE_SYNC_SIZE_LIMIT_MB` (default 50): sync payload ceilings. A budget with many years of transactions can grow past 20 MB; raising the limit is the fix if sync starts failing on upload.

The server reads `/data/config.json` if present, and environment variables override it. MOS does not write that file.

## First Start And The Bootstrap Window

The image ships no credentials. Until someone calls `POST /account/bootstrap`, `GET /account/needs-bootstrap` reports `bootstrapped: false` and the first visitor to the app URL is offered the "set a password" screen with no authentication in front of it.

The route is public as soon as the install finishes, and app hostnames are visible in certificate transparency logs, so this is a real if short window. Open `actual.<base-domain>` and set the password immediately after install.

The package deliberately collects no password as a setup field: the server has no environment variable that presets one, and the only startup-time bootstrap path upstream supports is OpenID. Closing the window properly needs an upstream credential-seeding mechanism, not manifest fields.

## Volumes And Persistence

- `data:/data`: everything. It holds `server-files/account.sqlite` (the server password hash, sessions, and any bank-sync API keys), `user-files/` (one folder per budget file, each with its own SQLite database and sync journal), and `.migrate`.

This single volume is the backup target; losing it loses the budgets. Disable stops and removes the container while keeping the route, volume and any stored secret references. Uninstall removes the container, route, MOS-owned Homepage shortcut, this volume, config and secret references.

Actual is local-first: each browser holds its own copy of the budget and syncs changes to the server. A restored server volume is authoritative, but a client that still has newer local changes will try to sync them on next open.

## Health Check

- `http://actual:5006/health`

Returns `200` with `{"status":"UP"}` and needs no session, before and after bootstrap. It is a dedicated liveness endpoint rather than a page borrowed from the UI, so it stays meaningful if the login flow changes.

## Outbound Network Behaviour

The image contains no analytics or crash-reporting library.

The server makes no outbound request on its own. The upstream hosts compiled into it are reached only when an owner switches something on:

- `bankaccountdata.gocardless.com`, `bridge.simplefin.org`, `api.enablebanking.com`, and the Pluggy.ai and Akahu endpoints: bank sync, each requiring API credentials the owner obtains and enters.
- `raw.githubusercontent.com`, `api.github.com`, `github.com`: the experimental plugin store, fetched through the server's `/cors-proxy` route. That route requires a valid session, is rate limited to 25 requests per minute, resolves and rejects private, loopback and link-local targets, and only forwards to repositories on the upstream plugin allowlist. Nothing is fetched until the browser asks for it.

The **web client** does make one request by default. `getLatestVersion()` fetches `https://api.github.com/repos/actualbudget/actual/releases/latest` and compares the tag with the running client's version, so the About screen can say a newer release exists. Points worth being precise about:

- It comes from the owner's browser, not from the server, so the address disclosed to GitHub is the owner's, not the box's.
- It carries no identifier: no install id, no version, no usage data. It is a read of a public URL.
- It is gated on the global preference `notifyWhenUpdateIsAvailable`, which defaults to on and is exposed as "Display a notification when updates are available" in Settings.
- Observed firing on first load of the budget during the screenshot capture session, which is how it was found rather than inferred.

Because it is a client-side preference rather than a server setting, there is no environment variable for this package to pin, and MOS does not disable it.

## Upgrades

The server runs SQLite migrations on start for both the account database and each budget file, hence `backupRequired: true` and brief downtime.

Actual's own guidance is to keep the sync server and the client in step; because MOS serves the client from the same image, that happens by construction. A budget file migrated by a newer server is not guaranteed to open on an older one, which is why `rollback: safe` refers to the container, not to reversing a data migration.

## Import And Export

Actual imports YNAB4 and nYNAB budgets and reads CSV, OFX/QFX and CAMT.053 transaction files, all through the web interface. Export produces a `.zip` of the budget file that can be re-imported into any Actual instance; it is the portable copy to keep alongside MOS volume backups.
