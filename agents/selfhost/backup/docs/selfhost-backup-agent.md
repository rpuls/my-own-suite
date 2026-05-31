# Self-host backup agent

`mos-backup-agent` is the host-owned bridge for offline backup and future restore actions.

The agent listens on `/run/mos-backup-agent/agent.sock`, authenticates with `/etc/mos-backup-agent/auth.token`, and stores job state under `/var/lib/mos-backup-agent`.

Current capabilities:

- `destinations.list`: reports supported mounted destinations under `/media`, `/mnt`, and `/run/media`, plus connected removable/USB block devices that still need mounting.
- `backups.create`: starts a persistent backup job for a selected mounted destination.
- `backups.list`: reports completed backup bundles found on currently mounted destinations.
- `restores.plan`: advertises the restore contract.
- `restores.apply`: starts a destructive host-owned restore job from a detected backup bundle.

Current backup jobs estimate detected Docker volume size before downtime, stop the MOS Docker Compose stack, archive detected MOS Docker volumes from their host mountpoints, record suite metadata, repo-managed runtime configuration, archive checksums, and the rendered Compose configuration, then start the same detected profiles again.

Restore jobs require an explicit confirmation, verify manifest/archive checksums and tar readability before downtime, save a pre-restore runtime-config rescue archive under agent state, stop the current MOS stack, restore repo-managed runtime configuration and Docker volumes from the selected bundle, then start the profiles recorded in the backup manifest. Restore should still be validated on real self-host hardware before it is treated as dependable for important data.
