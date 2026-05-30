# Self-host backup agent

`mos-backup-agent` is the host-owned bridge for offline backup and future restore actions.

The agent listens on `/run/mos-backup-agent/agent.sock`, authenticates with `/etc/mos-backup-agent/auth.token`, and stores job state under `/var/lib/mos-backup-agent`.

Current capabilities:

- `destinations.list`: reports mounted destinations under `/media`, `/mnt`, and `/run/media`.
- `backups.create`: starts a persistent backup job for a selected mounted destination.
- `restores.plan`: advertises the restore contract as planned, without performing restore yet.

The first backup-agent slice captures suite metadata and repo-managed runtime configuration. Docker volume archiving and automated restore are intentionally deferred until the cold offline bundle format has been validated on real self-host hardware.
