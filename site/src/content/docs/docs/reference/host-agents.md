---
title: Host agents
description: Reference for the six root-owned My Own Suite host agents — what each does, its systemd unit and socket, and how to inspect or restart them.
---

Host agents are the privileged half of the [MOS privilege boundary](/docs/reference/architecture/): small root-owned services that perform host actions on behalf of the unprivileged Suite Manager web app. Each one is a systemd service reachable **only** over its own local Unix socket (mode `0660`, group `mos-v2-agent` — no TCP ports, no LAN exposure), and each exposes a short list of explicit, validated operations rather than general command access.

## The agents

| Agent | Unit | What it owns |
| --- | --- | --- |
| HTTPS | `mos-v2-https-agent` | The [Cloudflare DNS-01 flow](/docs/guides/https-domain/): verifies the token against the zone, stores it root-only, rewrites the Caddyfile atomically with checkpoint/rollback, restarts Caddy. |
| Homepage | `mos-v2-homepage-agent` | Validates and applies allowlisted [dashboard YAML](/docs/guides/customize-homepage/) and the MOS-owned home route snippet; keeps a 10-checkpoint history; restarts/reloads only when content actually changed. |
| App runtime | `mos-v2-app-agent` | The Docker side of [app management](/docs/guides/apps/) — the largest agent, at contract version 9 with 14 capabilities. See below. |
| Backup | `mos-v2-backup-agent` | Drive discovery and mounting, whole-suite [backup and restore](/docs/guides/backup-restore/) jobs (one at a time). |
| Update | `mos-v2-update-agent` | [Managed updates](/docs/guides/updates/): track configuration and update jobs, each run as a transient systemd unit so an update survives the agent restarting itself. An orphaned job is marked failed after a timeout instead of blocking updates forever. |
| Lab reset | `mos-v2-lab-reset-agent` | **Lab installs only** (USB/Hyper-V with `MOS_V2_LAB_RESET_ENABLED=1`): clears disposable lab state for repeatable testing. Absent on normal installs. |

Sockets live at `/run/mos-v2-<name>-agent/agent.sock`.

## The app runtime agent

The app agent is where the boundary is under the most pressure, so it's worth spelling out. It accepts bounded structured projections and host-owned snapshot identities — never repository-relative build paths — across fourteen named capabilities:

- **Runtime** — `apps.multi-service.apply`, `apps.multi-service.stop`, `apps.multi-service.remove`, `apps.network.connect`, `apps.health.check`.
- **Snapshots** — `apps.package.snapshot` and `apps.package.snapshot.external`, which copy only validated package files into the host-owned root.
- **Updates** — `apps.package.update.stage`, `.build`, `.activate`, `.rollback`, `.promote`, `.reclaim`, plus `apps.package.remove.reclaim`.

It owns two storage roots. Installed [package snapshots](/docs/reference/app-packages/) live under `MOS_V2_APP_PACKAGE_ROOT` (`/var/lib/mos-v2/app-packages`, `root:mos-v2-agent`, mode `2750`, so Suite Manager can read but not write them); candidate downloads land under the private `MOS_V2_APP_CANDIDATE_ROOT` (`/var/lib/mos-v2/suite-manager/app-candidates`), the only place an unvalidated package may ever sit.

Three behaviors matter more than the list. The agent re-verifies the expected snapshot digest before it builds anything, so a candidate that changed after you previewed it is refused rather than built. Update stages are separate operations — build the candidate, activate it, then promote or roll back — so an interruption leaves a state that can be recovered or reported rather than a half-applied app. And promotion reclaims the images its own package digest names, using `docker image rm` without `--force`, so an image a container still needs simply stays. The agent also reports its host architecture, which is how Suite Manager refuses an incompatible package before a build fails halfway. Stop preserves routes, volumes, config, secrets, and snapshots; only the explicitly destructive remove deletes them.

## How they're installed and updated

All agents (and the Suite Manager / Homepage / Caddy units) are generated and refreshed by one reconciliation script, `scripts/reconcile-system.cjs` — run at install time and again during every [managed update](/docs/guides/updates/). That's what guarantees an update refreshes the agents along with everything else: reconciliation is the single writer of repo-owned units, sockets, groups, and the pinned Caddy binary.

## Operating them

They are ordinary systemd services:

```sh
systemctl status mos-v2-backup-agent     # is it running?
journalctl -u mos-v2-backup-agent -e     # its logs
systemctl restart mos-v2-backup-agent    # the classic fix
```

Suite Manager degrades gracefully per agent — if the Backup screen says the host backup service is unavailable, that means exactly one unit is down, and the other screens keep working. Running a managed update (or `sudo node scripts/reconcile-system.cjs` from `/opt/mos-v2/repo`) reconverges everything.

## Design rules

Two rules keep this layer trustworthy, and they are treated as architecture, not style:

1. **Agents grow by adding explicit capabilities, never by granting Suite Manager arbitrary host access.** Each new need becomes a named, validated operation.
2. **Secrets cross the boundary minimally.** App secrets are materialized per apply-request only; the Cloudflare token goes straight to a root-only file and is never readable back through any API.
