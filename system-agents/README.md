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

`apps/agent.cjs` runs over `/run/mos-v2-app-agent/agent.sock`. The current capability is intentionally narrow: it accepts a bounded validated app-package service projection, builds package-owned Dockerfiles under `apps/<app-id>/`, starts declared containers, creates a package-owned Docker network when a package has companion services, publishes only services referenced by structured public routes on assigned loopback ports, writes package-scoped blocks in `/etc/caddy/mos-v2-app-routes.caddy`, reloads Caddy, and waits for the loopback health endpoint. It may render constrained package-declared helper routes, such as the tokenized Radicale iCal bridge, from structured fields only.

`backup/agent.cjs` runs over `/run/mos-v2-backup-agent/agent.sock`. It owns local backup destinations, USB-style mount help, whole-suite backup jobs, detected bundle listing, and confirmed restore jobs. The first implementation writes a MOS V2 bundle under `MOS-v2-backups/` with a manifest, Suite Manager/Homepage/Caddy/HTTPS state archive, and app Docker volume archives. Restore is intentionally explicit and disruptive: it validates the bundle, saves a pre-restore rescue copy, stops the current runtime, restores suite state and app volumes, then starts the control plane again.

Suite Manager owns app install intent and SQLite projection state. The app agent owns privileged Docker, Caddy route writes, health probing, a non-destructive runtime stop action, and destructive uninstall host cleanup. Stop removes only containers declared by the persisted package projection and leaves routes, Homepage shortcuts, Docker volumes, app config, and secrets intact. Remove stops/removes declared containers, removes that package's Caddy route block, and deletes only MOS-named Docker volumes from the persisted package projection. Suite Manager deletes the matching app instance/config/projection state and app secret files after host cleanup succeeds. The agent does not accept arbitrary package paths, Docker commands, Caddy snippets, raw compose files, host paths, image removal, or broad host lifecycle requests.

Secret material is resolved before the request crosses into the app agent. Suite Manager stores raw generated package secrets only in its restricted app secret directory and sends materialized environment values to the agent for the single apply request. If a secret reference is missing, unreadable, or outside that directory, runtime apply fails with `APP_SECRET_UNAVAILABLE` before the agent is called.

## Update Agent

`update/agent.cjs` runs over `/run/mos-v2-update-agent/agent.sock`. It exposes only status, start-job, read-job, and track-configuration operations for managed V2 updates. It does not accept arbitrary shell commands, paths, service names, Docker operations, or Caddy text.

The first apply path is branch-track reconciliation for V2 lab installs. The agent starts each update worker as a transient systemd unit when systemd is available, so the job can survive `mos-v2-update-agent` being restarted by reconciliation. If an older job is left marked running after its worker disappears, the agent marks it failed with a truthful recovery message instead of blocking future updates forever. The worker fetches and fast-forwards the configured branch, installs root workspace dependencies and build tooling from `package-lock.json`, rebuilds the Suite Manager frontend, runs `scripts/reconcile-system.cjs`, and records bounded progress logs for Suite Manager. The reconciliation script refreshes repo-owned host services and agents, including the updater itself, before the job reports success.

Installed app runtimes are preserved in this first slice. If app package manifests or Dockerfiles changed, Suite Manager tells the owner to reapply or restart installed apps after the core update. Automatic app-runtime rebuild/reapply belongs to a later package-aware updater slice.

## Lab Reset Agent

`lab-reset/agent.cjs` runs over `/run/mos-v2-lab-reset-agent/agent.sock` only on USB/Hyper-V lab installs where `MOS_V2_LAB_RESET_ENABLED=1`. Suite Manager exposes `/suite-manager/api/lab/reset` only when that flag is set; non-lab installs return `LAB_RESET_DISABLED`.

The agent schedules a repo-owned reset worker and returns before Suite Manager is restarted. The worker clears only disposable lab state: Suite Manager SQLite/session/app state, Homepage runtime config, MOS-owned Homepage/app Caddy route snippets, and `mos-v2-app-*` Docker containers, networks, and volumes. It preserves the VM, installed repo checkout, npm dependencies, pinned control-plane images, HTTPS secret files, and backup disk state.
