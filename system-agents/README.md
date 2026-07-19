# MOS System Agents

Host-side privileged agents live here.

Use this area for service, update, backup, and restore agents. Suite Manager talks to these agents through narrow local APIs instead of gaining broad host privileges.

## HTTPS Agent

`https/agent.cjs` is the first MOS privileged agent. It runs as root and exposes only status plus Cloudflare DNS-01 apply, commit, and rollback over `/run/mos-https-agent/agent.sock`. The socket is writable only by the dedicated `mos-agent` group.

The agent validates the exact structured request, verifies the pinned Caddy module, verifies the Cloudflare token and readable active zone, and stores the token only in `/etc/mos/secrets/caddy-cloudflare.env` with mode `0600`. It creates a root-only checkpoint, atomically installs the secret and repo-rendered Caddyfile, validates and reloads Caddy, and restores the checkpoint on failure. Errors and logs are fixed and sanitized; they never include request values or command output.

Suite Manager persists active non-secret state before committing the short-lived checkpoint. If persistence fails it requests rollback. Suite Manager itself is never restarted during an HTTPS apply.

## Homepage Agent

`homepage/agent.cjs` runs separately over `/run/mos-homepage-agent/agent.sock`. It exposes only status, allowlisted file read/validation/apply, add-link, add-home-service, and stable-ID remove-link operations. It has no arbitrary path, shell, service, command, or Caddy-text capability.

The agent validates strict YAML and MOS proxy metadata, stages `services.yaml` and the separate MOS-owned route snippet, runs Caddy validation, atomically writes, restarts Homepage only when required, and reloads Caddy only for changed routes. Any validation, restart, or reload failure restores the known-good Homepage and route files. It never restarts Suite Manager and never modifies the HTTPS agent's main Caddyfile or DNS token state.

Homepage restarts have a dedicated 60-second deadline rather than the generic 20-second command deadline. Suite Manager's socket client waits longer than that operation, and its systemd unit is not stop-coupled to Homepage, so the request remains connected until the transaction succeeds or returns a controlled failure.

## App Runtime Agent

`apps/agent.cjs` runs over `/run/mos-app-agent/agent.sock`. It accepts bounded structured projections and host-owned package snapshot identities, never repository-relative build paths. Its narrow capabilities create and verify official or external snapshots, apply/stop/remove multi-service runtimes, check health, connect declared package networks, and stage, build, activate, roll back, promote, recover, and reclaim transactional app updates. It builds only package-owned Dockerfiles from a digest-verified installed or candidate snapshot, creates package-owned networks, publishes only structured public routes on assigned loopback ports, writes package-scoped Caddy blocks, reloads Caddy, and waits for loopback health. It reports its host architecture so Suite Manager can reject incompatible packages before building.

`backup/agent.cjs` runs over `/run/mos-backup-agent/agent.sock`. It owns local backup destinations, USB-style mount help, whole-suite backup jobs, detected bundle listing, and confirmed restore jobs. A MOS bundle under `MOS-backups/` contains a manifest, Suite Manager/Homepage/Caddy/HTTPS state, exact installed app-package snapshots, and app Docker volume archives. The manifest records installed source identity and hashes the state archive, every volume archive, and every package file. Restore validates those identities and payloads before stopping services, restores package snapshots before app reconciliation, then starts the control plane again. A snapshot preserves the build definition but cannot guarantee that a third-party registry still serves every pinned base image; unavailable artifacts fail visibly instead of being replaced.

Suite Manager owns app install intent and SQLite projection state. The app agent owns privileged Docker, Caddy route writes, health probing, snapshots beneath `MOS_APP_PACKAGE_ROOT`, and candidates beneath the private `MOS_APP_CANDIDATE_ROOT`. Official snapshot creation derives its source from `MOS_APPS_ROOT`; external snapshot creation resolves the supplied candidate and root through canonical filesystem paths before reading it. Both validate package identity and digest and atomically promote files without replacing installed state. Runtime apply re-verifies the installed snapshot before building. Update promotion keeps at most one previous snapshot only when rollback is declared safe; that copy supports bounded transaction recovery and forensics, not an owner-facing data rollback guarantee. Reclamation removes only digest-qualified package images unused by containers. Stop preserves routes, Homepage entries, volumes, config, secrets, and snapshots. Remove deletes only the named package runtime, routes, MOS-named volumes, images, and instance snapshot. The agent never accepts arbitrary Docker commands, raw Compose/Caddy, host paths, or broad host lifecycle requests.

Secret material is resolved before the request crosses into the app agent. Suite Manager stores raw generated package secrets only in its restricted app secret directory and sends materialized environment values to the agent for the single apply request. If a secret reference is missing, unreadable, or outside that directory, runtime apply fails with `APP_SECRET_UNAVAILABLE` before the agent is called.

## Update Agent

`update/agent.cjs` runs over `/run/mos-update-agent/agent.sock`. It exposes only status, start-job, read-job, and track-configuration operations for managed MOS updates. It does not accept arbitrary shell commands, paths, service names, Docker operations, or Caddy text.

The first apply path is branch-track reconciliation for MOS lab installs. The agent starts each update worker as a transient systemd unit when systemd is available, so the job can survive `mos-update-agent` being restarted by reconciliation. If an older job is left marked running after its worker disappears, the agent marks it failed with a truthful recovery message instead of blocking future updates forever. The worker fetches and fast-forwards the configured branch, installs root workspace dependencies and build tooling from `package-lock.json`, rebuilds the Suite Manager frontend, runs `scripts/reconcile-system.cjs`, and records bounded progress logs for Suite Manager. The reconciliation script refreshes repo-owned host services and agents, including the updater itself, before the job reports success.

Installed app runtimes are decoupled from the moving repository checkout. Core managed updates refresh every repo-owned host agent, while each installed app continues to run and be managed from its preserved snapshot. Package updates are discovered and applied independently through the app update transaction; a core update does not silently rebuild apps from newer repository package files.

## Lab Reset Agent

`lab-reset/agent.cjs` runs over `/run/mos-lab-reset-agent/agent.sock` only on USB/Hyper-V lab installs where `MOS_LAB_RESET_ENABLED=1`. Suite Manager exposes `/suite-manager/api/lab/reset` only when that flag is set; non-lab installs return `LAB_RESET_DISABLED`.

The agent schedules a repo-owned reset worker and returns before Suite Manager is restarted. The worker clears only disposable lab state: Suite Manager SQLite/session/app state, Homepage runtime config, MOS-owned Homepage/app Caddy route snippets, and `mos-app-*` Docker containers, networks, and volumes. It preserves the VM, installed repo checkout, npm dependencies, pinned control-plane images, HTTPS secret files, and backup disk state.
