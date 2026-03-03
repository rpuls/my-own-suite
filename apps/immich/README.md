#### Service: `immich` (server)

Environment variables:
- `TZ`
- `DB_HOSTNAME`
- `DB_PORT`
- `DB_USERNAME`
- `DB_PASSWORD`
- `DB_DATABASE_NAME`
- `REDIS_HOSTNAME`
- `REDIS_PORT`
- `REDIS_PASSWORD` (required when Redis auth is enabled)
- `IMMICH_MACHINE_LEARNING_URL`
- `UPLOAD_LOCATION`

Volumes:
- Required: `/usr/src/app/upload`

Start command:
- Use the image default command (no override required).

Resource baseline:
- Recommended minimum: `1 GB RAM`, `1 vCPU`
- Preferred for smoother operation: `2 GB RAM`

#### Service: `immich-machine-learning`

Environment variables:
- `TZ`

Volumes:
- Recommended: `/cache`

Start command:
- Use the image default command (no override required).

Resource baseline:
- Recommended minimum: `1 GB RAM`, `1 vCPU`
- Preferred when processing large libraries: `2 GB RAM`

#### Service: `immich-postgres`

Environment variables:
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DB`
- `POSTGRES_INITDB_ARGS` (recommended: `--data-checksums`)
- `PGDATA` (recommended on mounted volumes: `/var/lib/postgresql/data/pgdata`)

Volumes:
- Required: `/var/lib/postgresql/data`

Start command:
```bash
/usr/local/bin/immich-docker-entrypoint.sh postgres -c config_file=/etc/postgresql/postgresql.conf -c shared_preload_libraries=vchord.so,vectors.so
```

Resource baseline:
- Recommended minimum for stable bootstrap: `2 GB RAM`, `1 vCPU`
- Preferred for smoother first-run import/indexing: `4 GB RAM`

#### Service: `immich-redis`

Environment variables:
- `REDIS_PASSWORD` (required only if Redis auth is enabled)

Volumes:
- None required.

Start command:
- Use the image default command (no override required).
- If Redis auth is enabled, override start command:
```bash
redis-server --requirepass "$REDIS_PASSWORD"
```

Resource baseline:
- Recommended minimum: `256 MB RAM`, `0.5 vCPU`

#### Required service wiring

- `immich` -> `immich-postgres`: `DB_HOSTNAME`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE_NAME`
- `immich` -> `immich-redis`: `REDIS_HOSTNAME`, `REDIS_PORT`, `REDIS_PASSWORD` (when Redis auth is enabled)
- `immich` -> `immich-machine-learning`: `IMMICH_MACHINE_LEARNING_URL`
