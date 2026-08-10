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

## Health Check

Endpoint: `GET /api/server/ping` (returns `{"res":"pong"}`; the same path the upstream image's own `immich-healthcheck` uses)

## Notes

- First admin account is created directly in Immich web UI after first startup
- The server and machine-learning images are pinned to the amd64 manifests for Immich v3.1.0. The database and Valkey images follow the digests pinned by the official Immich v3.1.0 Docker Compose file rather than their moving tags, so the package runs the combination upstream tests.
- Immich database migrations are forward-only. Once a v3.1.0 instance has started and migrated, repinning the images to an earlier Immich version is not supported by upstream.
- Machine learning requires CPU with AVX2 support for optimal performance
- All services are internal except the main Immich server port
- Startup may take several minutes on first run while database is initialized
