#### Environment variables

- `TZ`: Container timezone.
- `DB_HOSTNAME`: PostgreSQL hostname reachable from Immich server.
- `DB_PORT`: PostgreSQL port (typically `5432`).
- `DB_USERNAME`: PostgreSQL username used by Immich.
- `DB_PASSWORD`: PostgreSQL password used by Immich.
- `DB_DATABASE_NAME`: PostgreSQL database name used by Immich.
- `REDIS_HOSTNAME`: Redis hostname reachable from Immich server.
- `REDIS_PORT`: Redis port (typically `6379`).
- `IMMICH_MACHINE_LEARNING_URL`: Internal URL for machine-learning service.
- `UPLOAD_LOCATION`: Upload storage path inside the Immich server container.
- `POSTGRES_USER`: PostgreSQL bootstrap user for the database container.
- `POSTGRES_PASSWORD`: PostgreSQL bootstrap password for the database container.
- `POSTGRES_DB`: PostgreSQL bootstrap database name for the database container.

#### Volumes and persistence

- Required persistent mounts:
  - `/usr/src/app/upload` (Immich library uploads and generated assets)
  - `/var/lib/postgresql/data` (PostgreSQL data directory)
- Recommended persistent mount:
  - `/cache` for `immich-machine-learning` model cache.

#### Health check

- Immich server endpoint: `/api/server/ping`

#### Dependencies and integrations

- Requires PostgreSQL with vector extension support.
- Requires Redis for queue/cache operations.
- Requires `immich-machine-learning` service for face/object/smart-search features.

#### Customizations in this project

- `apps/immich/server/Dockerfile` is the Railway/VPS build target for Immich server.
- `apps/immich/machine-learning/Dockerfile` is the Railway build target for Immich machine-learning worker.
- `apps/immich/postgres/Dockerfile` is the Railway/VPS build target for Immich's vector-enabled PostgreSQL.

#### Operational commands

- Start Immich profile (repo root):
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps --profile immich up -d`
- Inspect Immich logs:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps logs immich --tail 120`
