# Immich

High performance self-hosted photo and video backup solution.

## Services

| Service | Image | Port |
|---|---|---|
| `immich-server` | Immich Server | 2283 |
| `immich-machine-learning` | Immich ML | 3003 |
| `immich-postgres` | Immich PostgreSQL 14 with VectorChord | 5432 |
| `immich-valkey` | Valkey 9 | 6379 |

## Volumes

| Volume | Path | Description |
|---|---|---|
| `library` | `/usr/src/app/upload` | Primary photo and video storage |
| `postgres-data` | `/var/lib/postgresql/data` | Database metadata |
| `cache` | `/usr/src/app/cache` | Thumbnails and previews |
| `model-cache` | `/cache` | Machine learning model cache |

## Environment Variables

| Variable | Source |
|---|---|
| `DB_PASSWORD` | Generated secret |
| `JWT_SECRET` | Generated secret |
| `PUBLIC_HOSTNAME` | Runtime app route |
| `POSTGRES_INITDB_ARGS` | Enables data checksums for Immich database initialization |
| `MOS_ADMIN_EMAIL`, `MOS_ADMIN_PASSWORD` | The administrator login from the two setup fields |
| `MACHINE_LEARNING_MODEL_REVISION` | `v2` on `immich-machine-learning`: Immich's optimised model exports, all from Hugging Face. They are cached under `/cache/<task>/<model>/v2`, and models cached by an earlier package stay beside them unused |
| `ORT_DISABLE_TELEMETRY` | `1`, baked into `Dockerfile.machine-learning`, so onnxruntime never sends usage telemetry to Microsoft |

## Photos Folder On The Owner's Drive

The manifest declares one optional folder under `storage`. Install never asks for it: the owner picks a drive later in the app's settings in Suite Manager, and MOS creates `MOS-files/apps/immich/Photos` on it and mounts it read-only at `/media/photos` in `immich-server`. It is not an app volume: the suite backup does not include it and uninstall leaves it on the drive. Without a drive Immich runs as before and the folder is simply not mounted.

Read-only means Immich can neither delete those photos nor write XMP sidecars beside them. From Immich 3.4 the scan does not follow symbolic links, so a link in the folder is not imported; files imported through a link before 3.4 stay. Assets whose files go missing while the drive is away are shown offline, not removed, and return when the drive does.

## First Start

`entrypoint.sh` runs a background job against `http://localhost:2283/api` once `/server/ping` answers:

1. On a server with no administrator, signs one up with `MOS_ADMIN_EMAIL` and `MOS_ADMIN_PASSWORD` and clears Immich's change-password-at-first-sign-in flag. On a server that already has one, signs in with them instead.
2. Creates an API key named `MOS`, kept in `/usr/src/app/upload/.mos-api-key` (mode 0600), so later starts still work after the owner changes the password.
3. If `/media/photos` is mounted, creates an external library named Photos over it unless one exists, and starts a scan of it. That runs on every start, and MOS restarts the container when the drive is plugged back in, so photos copied onto the drive elsewhere are found then.

A failed step is logged with a `MOS:` prefix and retried at the next start; it never holds the server back.

## Health Check

Endpoint: `GET /api/server/ping` (returns `{"res":"pong"}`; the same path the upstream image's own `immich-healthcheck` uses)

## Notes

- The server and machine-learning images are pinned to the amd64 manifests for Immich v3.4.1. The database and Valkey images follow the amd64 manifests of the digests pinned by the official Immich v3.4.1 Docker Compose file (Valkey 9.1.2) rather than their moving tags, so the package runs the combination upstream tests.
- Immich database migrations are forward-only. Once a v3.4.1 instance has started and migrated, repinning the images to an earlier Immich version is not supported by upstream.
- `immich-config.json` sets `backup.beta` to `false`, so the FUTO Backups screens stay hidden. The server still loads the FUTO Backups module, adds its empty `futo_backups_*` tables to the database and logs a harmless warning that both `/data` and `/usr/src/app/upload` exist. Media stays in `/usr/src/app/upload`.
- Machine learning requires CPU with AVX2 support for optimal performance
- All services are internal except the main Immich server port
- Startup may take several minutes on first run while database is initialized
