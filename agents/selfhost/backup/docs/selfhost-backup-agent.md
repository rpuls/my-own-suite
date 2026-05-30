# Self-host backup agent

`mos-backup-agent` is the host-owned bridge for offline backup and future restore actions.

The agent listens on `/run/mos-backup-agent/agent.sock`, authenticates with `/etc/mos-backup-agent/auth.token`, and stores job state under `/var/lib/mos-backup-agent`.

Current capabilities:

- `destinations.list`: reports mounted destinations under `/media`, `/mnt`, and `/run/media`.
- `backups.create`: starts a persistent backup job for a selected mounted destination.
- `backups.list`: reports completed backup bundles found on currently mounted destinations.
- `restores.plan`: advertises the restore contract as planned, without performing restore yet.

Current backup jobs estimate detected Docker volume size before downtime, stop the MOS Docker Compose stack, archive detected MOS Docker volumes from their host mountpoints, record suite metadata, repo-managed runtime configuration, archive checksums, and the rendered Compose configuration, then start the same detected profiles again.

Automated restore is still deferred until backup bundles have been validated on real self-host hardware.
