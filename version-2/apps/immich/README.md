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

Endpoint: `GET /api/server-info/ping`

## Notes

- First admin account is created directly in Immich web UI after first startup
- The server and machine-learning images are pinned to the amd64 manifests for Immich v3.0.2. The database image follows the official Immich v3.0.2 Docker Compose service, while Valkey provides the Redis-compatible cache service used by Immich.
- Machine learning requires CPU with AVX2 support for optimal performance
- All services are internal except the main Immich server port
- Startup may take several minutes on first run while database is initialized
