# V2 System Agents

Host-side privileged agents live here.

Use this area for service, update, backup, and restore agents. Suite Manager talks to these agents through narrow local APIs instead of gaining broad host privileges.

## HTTPS Agent

`https/agent.cjs` is the first V2 privileged agent. It runs as root and exposes only status plus Cloudflare DNS-01 apply, commit, and rollback over `/run/mos-v2-https-agent/agent.sock`. The socket is writable only by the dedicated `mos-v2-agent` group.

The agent validates the exact structured request, verifies the pinned Caddy module, verifies the Cloudflare token and readable active zone, and stores the token only in `/etc/mos-v2/secrets/caddy-cloudflare.env` with mode `0600`. It creates a root-only checkpoint, atomically installs the secret and repo-rendered Caddyfile, validates and reloads Caddy, and restores the checkpoint on failure. Errors and logs are fixed and sanitized; they never include request values or command output.

Suite Manager persists active non-secret state before committing the short-lived checkpoint. If persistence fails it requests rollback. Suite Manager itself is never restarted during an HTTPS apply.

## Homepage Agent

`homepage/agent.cjs` runs separately over `/run/mos-v2-homepage-agent/agent.sock`. It exposes only status, allowlisted file read/validation/apply, add-link, add-home-service, and stable-ID remove-link operations. It has no arbitrary path, shell, service, command, or Caddy-text capability.

The agent validates strict YAML and MOS proxy metadata, stages `services.yaml` and the separate MOS-owned route snippet, runs Caddy validation, atomically writes, restarts Homepage only when required, and reloads Caddy only for changed routes. Any validation, restart, or reload failure restores the known-good Homepage and route files. It never restarts Suite Manager and never modifies the HTTPS agent's main Caddyfile or DNS token state.

Homepage restarts have a dedicated 60-second deadline rather than the generic 20-second command deadline. Suite Manager's socket client waits longer than that operation, and its systemd unit is not stop-coupled to Homepage, so the request remains connected until the transaction succeeds or returns a controlled failure.

## App Runtime Agent

`apps/agent.cjs` runs over `/run/mos-v2-app-agent/agent.sock`. The current capability is intentionally narrow: it accepts a bounded validated app-package service projection, builds package-owned Dockerfiles under `version-2/apps/<app-id>/`, starts declared containers, creates a package-owned Docker network when a package has companion services, publishes only services referenced by structured public routes on assigned loopback ports, writes package-scoped blocks in `/etc/caddy/mos-v2-app-routes.caddy`, reloads Caddy, and waits for the loopback health endpoint. It may render constrained package-declared helper routes, such as the tokenized Radicale iCal bridge, from structured fields only.

Suite Manager owns app install intent and SQLite projection state. The app agent owns privileged Docker, Caddy route writes, health probing, and the non-destructive remove-runtime action used by disable and preserved-data uninstall. Remove stops/removes only containers declared by the persisted package projection and removes only that package's Caddy route block; it does not delete Docker volumes, app config, or secrets. It does not accept arbitrary package paths, Docker commands, Caddy snippets, raw compose files, or broad host lifecycle requests.

Secret material is resolved before the request crosses into the app agent. Suite Manager stores raw generated package secrets only in its restricted app secret directory and sends materialized environment values to the agent for the single apply request. If a secret reference is missing, unreadable, or outside that directory, runtime apply fails with `APP_SECRET_UNAVAILABLE` before the agent is called.
