# MOS System Agents

Host-side privileged agents live here.

Use this area for service, update, backup, and restore agents. Suite Manager talks to these agents through narrow local APIs instead of gaining broad host privileges.

## What a failure carries

Every agent runs its privileged commands through `lib/command-output.cjs`. The runner keeps a bounded rolling tail of what a command writes and, when the command fails, hands back its last 60 lines (at most 8 000 characters) with the exit code or the deadline that stopped it. A command that overruns its deadline is stopped together with the process group it started, since `npm run` and `docker build` do their work in children. Each agent attaches that to its fixed error sentence as `details`, so a failed `docker build`, a Caddy validation that rejected a file, or a service that would not restart travels with its reason to Suite Manager, into the persisted operation record, onto the screen that reports it, and into the file an owner sends for help.

What is never captured is the command line. App containers are started with materialized secrets on their argv, so an error path that echoed what it tried to run would leak every secret of an app at once. A failure is described under a label the caller chose — `docker build for service "web"`, `systemctl restart mos-homepage.service` — and the arguments stay in the process table where they always were. Output is masked by exact value for whatever the agent itself materialized, such as the environment values on a `docker run` or the Cloudflare token, before it leaves root; Suite Manager masks it again against the full secret set it holds before the text reaches SQLite. Neither mask guesses at what a secret looks like.

## HTTPS Agent

`https/agent.cjs` is the first MOS privileged agent. It runs as root and exposes only status plus Cloudflare DNS-01 apply, commit, and rollback over `/run/mos-https-agent/agent.sock`. The socket is writable only by the dedicated `mos-agent` group.

The agent validates the exact structured request, verifies the pinned Caddy module, verifies the Cloudflare token and readable active zone, and stores the token only in `/etc/mos/secrets/caddy-cloudflare.env` with mode `0600`. It creates a root-only checkpoint, atomically installs the secret and repo-rendered Caddyfile, validates and reloads Caddy, and restores the checkpoint on failure. Its error sentences are fixed per code; a failure's `details` carry the last output of the command that failed, or what Cloudflare answered, with the token masked, and never a command line or a request value. A restore that fails too reports both reasons, the apply's first, and keeps the checkpoint on disk.

Suite Manager persists active non-secret state before committing the short-lived checkpoint. If persistence fails it requests rollback. Suite Manager itself is never restarted during an HTTPS apply.

## Homepage Agent

`homepage/agent.cjs` runs separately over `/run/mos-homepage-agent/agent.sock`. It exposes only status, allowlisted file read/validation/apply, add-link, add-home-service, and stable-ID remove-link operations. It has no arbitrary path, shell, service, command, or Caddy-text capability.

The agent validates strict YAML and MOS proxy metadata, stages `services.yaml` and the separate MOS-owned route snippet, runs Caddy validation, atomically writes, restarts Homepage only when required, and reloads Caddy only for changed routes. Any validation, restart, or reload failure restores the known-good Homepage and route files and reports what `caddy` or `systemctl` wrote; a restart or reload failure adds the last lines of the unit's own journal, read before the rollback restarts the unit so the log still ends with the failure rather than the recovery. It never restarts Suite Manager and never modifies the HTTPS agent's main Caddyfile or DNS token state.

Homepage restarts have a dedicated 60-second deadline rather than the generic 20-second command deadline. Suite Manager's socket client waits longer than that operation, and its systemd unit is not stop-coupled to Homepage, so the request remains connected until the transaction succeeds or returns a controlled failure.

## App Runtime Agent

`apps/agent.cjs` runs over `/run/mos-app-agent/agent.sock`. It accepts bounded structured projections and host-owned package snapshot identities, never repository-relative build paths. Its narrow capabilities create and verify official or external snapshots, apply/stop/remove multi-service runtimes, check health, connect declared package networks, and stage, build, activate, roll back, promote, recover, and reclaim transactional app updates. It builds only package-owned Dockerfiles from a digest-verified installed or candidate snapshot, creates package-owned networks, publishes only structured public routes on assigned loopback ports, writes package-scoped Caddy blocks, reloads Caddy, and waits for loopback health. It reports its host architecture so Suite Manager can reject incompatible packages before building.

Every container it creates is given `--log-opt max-size=10m --log-opt max-file=3`. Docker's json-file driver is otherwise unbounded, so one app logging on a loop fills the root disk and takes the suite down with it. The caps are per container rather than a daemon-wide `daemon.json` default, because changing that requires restarting dockerd and so stopping every running app; a container created before this applies picks the caps up the next time its app is applied or updated.

`backup/agent.cjs` runs over `/run/mos-backup-agent/agent.sock`. It owns local backup destinations, USB-style mount help, whole-suite backup jobs, detected bundle listing, and confirmed restore jobs. A MOS bundle under `MOS-backups/` contains a manifest, Suite Manager/Homepage/Caddy/HTTPS state, exact installed app-package snapshots, and app Docker volume archives. The manifest records installed source identity and hashes the state archive, every volume archive, and every package file. Restore validates those identities and payloads before stopping services, restores package snapshots before app reconciliation, then starts the control plane again. A snapshot preserves the build definition but cannot guarantee that a third-party registry still serves every pinned base image; unavailable artifacts fail visibly instead of being replaced.

Suite Manager owns app install intent and SQLite projection state. The app agent owns privileged Docker, Caddy route writes, health probing, snapshots beneath `MOS_APP_PACKAGE_ROOT`, and candidates beneath the private `MOS_APP_CANDIDATE_ROOT`. Official snapshot creation derives its source from `MOS_APPS_ROOT`; external snapshot creation resolves the supplied candidate and root through canonical filesystem paths before reading it. Both validate package identity and digest and atomically promote files without replacing installed state. Runtime apply re-verifies the installed snapshot before building. Update promotion keeps at most one previous snapshot only when rollback is declared safe; that copy supports bounded transaction recovery and forensics, not an owner-facing data rollback guarantee. Reclamation removes only digest-qualified package images unused by containers. Stop preserves routes, Homepage entries, volumes, config, secrets, and snapshots. Remove deletes only the named package runtime, routes, MOS-named volumes, images, and instance snapshot. The agent never accepts arbitrary Docker commands, raw Compose/Caddy, host paths, or broad host lifecycle requests.

Secret material is resolved before the request crosses into the app agent. Suite Manager stores raw generated package secrets only in its restricted app secret directory and sends materialized environment values to the agent for the single apply request. If a secret reference is missing, unreadable, or outside that directory, runtime apply fails with `APP_SECRET_UNAVAILABLE` before the agent is called. A build or `docker run` that fails reports the command's last output with the service's secret-shaped environment values masked; a health timeout, where nothing exited non-zero, reports each container's state and last log lines instead.

## Update Agent

`update/agent.cjs` runs over `/run/mos-update-agent/agent.sock`. It exposes only status, start-job, read-job, and track-configuration operations for managed MOS updates. It does not accept arbitrary shell commands, paths, service names, Docker operations, or Caddy text.

The first apply path is branch-track reconciliation for MOS lab installs. The agent starts each update worker as a transient systemd unit when systemd is available, so the job can survive `mos-update-agent` being restarted by reconciliation. If an older job is left marked running after its worker disappears, the agent marks it failed with a truthful recovery message instead of blocking future updates forever. The worker fetches and fast-forwards the configured branch, installs root workspace dependencies and build tooling from `package-lock.json`, rebuilds the Suite Manager frontend, runs `scripts/reconcile-system.cjs`, and records bounded progress logs for Suite Manager. The reconciliation script refreshes repo-owned host services and agents, including the updater itself, before the job reports success. A step that fails names itself and keeps the tail of what it wrote in the job record, which Suite Manager shows on the Updates screen and includes in the diagnostics bundle; the worker's full stream still goes to the transient unit's journal. Each step has a one-hour deadline, so a stuck step fails the job instead of holding it open forever.

Installed app runtimes are decoupled from the moving repository checkout. Core managed updates refresh every repo-owned host agent, while each installed app continues to run and be managed from its preserved snapshot. Package updates are discovered and applied independently through the app update transaction; a core update does not silently rebuild apps from newer repository package files.

## Diagnostics Agent

`diagnostics/agent.cjs` runs over `/run/mos-diagnostics-agent/agent.sock`. It exposes only status and a single `collect` operation, and that operation **takes no request body at all**: the collector list is compiled into `diagnostics/agent-core.cjs`, so a caller cannot name a unit, container, path, or line count. This is the security argument for the agent, not a convenience — a root process that reads host state on behalf of an unprivileged web app must not be steerable by it, or it is an arbitrary-file-read primitive. Adding a source means editing the list and shipping it. A unit test asserts `collect` has no parameters, so widening it cannot pass unnoticed.

It reads systemd unit states and journals for MOS-owned units, `docker ps` and per-container logs for containers named `mos-*`, and fixed host facts (`uname`, `uptime`, `df`, `free`, `docker system df`). Here command output is the whole result rather than the explanation of a failure, and it is captured on success as well; like every agent it never captures command arguments, for the reason given above.

Collection is best-effort per source. This runs on a machine that is by definition not well, so a collector that fails is an expected outcome, not an exceptional one; each failure is named in `incomplete` and the rest of the bundle is still returned. A collection already in flight is joined rather than duplicated.

The agent performs no redaction. It returns raw text to Suite Manager, which holds the plaintext of every app secret and is therefore the only component that can mask by exact value. Nothing the agent returns reaches disk or a log line before that redaction runs.

## Lab Reset Agent

`lab-reset/agent.cjs` runs over `/run/mos-lab-reset-agent/agent.sock` only on USB/Hyper-V lab installs where `MOS_LAB_RESET_ENABLED=1`. Suite Manager exposes `/suite-manager/api/lab/reset` only when that flag is set; non-lab installs return `LAB_RESET_DISABLED`.

The agent schedules a repo-owned reset worker and returns before Suite Manager is restarted. The worker clears only disposable lab state: Suite Manager SQLite/session/app state, Homepage runtime config, MOS-owned Homepage/app Caddy route snippets, and `mos-app-*` Docker containers, networks, and volumes. It preserves the VM, installed repo checkout, npm dependencies, pinned control-plane images, HTTPS secret files, and backup disk state.
