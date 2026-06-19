# V2 Infrastructure

Shared runtime substrate lives here when it is not owned by one app.

Use this area for future Caddy base config, Compose assembly/templates, Docker build conventions, projection contracts, and generated-output schemas.

Placement rule:

- App-specific Dockerfiles and snippets belong in `version-2/apps/<app>/`.
- Shared Caddy/Compose/Docker substrate belongs here.
- Suite Manager orchestrates state and intent; system agents apply privileged host changes.
