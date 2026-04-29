# My Own Suite - Self-Host Tooling

This folder contains self-host-specific tooling and supporting assets.

Canonical user-facing documentation for the self-host flow lives here:

- [site/src/content/docs/deploy-on-your-own-hardware.mdx](../../site/src/content/docs/deploy-on-your-own-hardware.mdx)

Current scripts:

- [scripts/selfhost/bootstrap-ubuntu.sh](../../scripts/selfhost/bootstrap-ubuntu.sh)
- [scripts/mos-updater.cjs](../../scripts/mos-updater.cjs)
- [scripts/selfhost-write-autoinstall.cjs](../../scripts/selfhost-write-autoinstall.cjs)
- [scripts/selfhost-write-cloudflared.cjs](../../scripts/selfhost-write-cloudflared.cjs)
- [scripts/selfhost-new-seed-disk.ps1](../../scripts/selfhost-new-seed-disk.ps1)
- [scripts/selfhost-build-installer-iso.cjs](../../scripts/selfhost-build-installer-iso.cjs)
- [update/selfhost/install-update-agent.sh](../../update/selfhost/install-update-agent.sh)

Keep the actual self-host guidance in the site docs so the public documentation stays the single source of truth.

## Contributor Notes

The current self-host tooling also includes a Hyper-V-oriented dry-run path for developing the future unattended install flow without waiting for the final mini PC hardware.

That internal test flow is not part of the public user docs yet.

High-level flow:

1. Generate unattended Ubuntu seed files with `npm run selfhost:autoinstall -- --password-hash '<hash>'`
2. Build a small `CIDATA` VHDX from those files with `scripts/selfhost-new-seed-disk.ps1`
3. Attach the Ubuntu Server ISO plus that `CIDATA` disk to a Generation 2 Hyper-V VM
4. Let cloud-init consume the seed and run the first-boot MOS bootstrap service

The goal of this path is to validate unattended installation mechanics and fresh-machine assumptions while the public self-host experience is still being productized.

## Single-USB Builder

The repo now also has an early single-USB installer builder:

```powershell
npm run selfhost:build-installer-iso
```

If `deploy/self-host/autoinstall/ubuntu-iso/` is empty, the builder now downloads the official supported Ubuntu Server ISO automatically and verifies it against Ubuntu's published `SHA256SUMS`.

If you prefer, you can still place exactly one Ubuntu Server ISO there yourself before running the builder.

Then copy:

- `deploy/self-host/autoinstall/installer-config/selfhost-installer.env.template`

to:

- `deploy/self-host/autoinstall/installer-config/selfhost-installer.env`

and fill in the stack domain, owner, and Linux passwords you want the installer to use.

Optional installer track settings:

- `REPO_REF` controls which branch or ref is checked out on first boot.
- `UPDATE_TRACK=branch` tells self-host test installs to follow a branch head for updates.
- `UPDATE_TRACK=stable` is the intended long-term production model for release-following installs.
- `UPDATE_REF` identifies the tracked branch when `UPDATE_TRACK=branch`.

What it does:

1. Generates fresh `user-data` and `meta-data`
2. Converts the local installer config into one first-boot manifest at `/etc/mos-selfhost.env`
3. Builds a small Docker-based ISO remaster environment with `xorriso`
4. Injects the MOS autoinstall seed into the Ubuntu ISO under `/autoinstall/`
5. Patches Ubuntu GRUB config to keep the normal Ubuntu boot path as the default and add a separate explicit `Install My Own Suite (ERASES DISK)` entry
6. Writes a single output ISO under `deploy/self-host/output/`

The installed first-boot launcher is intentionally thin: it loads `/etc/mos-selfhost.env`, clones the configured repo/ref, and delegates stack setup to the repo-owned bootstrap script. That keeps app env generation centralized in `vps:init`.

This is the intended direction for the HP mini PC flow because it removes the separate `CIDATA` disk from the final installation experience.

## Manual update foundation

The current updater foundation is explicit and user-triggered only.

- `npm run update:check` inspects the installed suite state and compares it against either the latest stable release metadata or the configured branch head, depending on the active update track.
- `npm run update:status` shows the last updater state saved on that machine.
- `npm run update:apply -- --target latest --yes` is the first manual apply path for self-host/VPS installs.

The updater now also has an experimental branch-following path for self-host development machines:

- `MOS_UPDATE_TRACK=stable` follows published release metadata.
- `MOS_UPDATE_TRACK=branch` follows the configured branch head instead.
- Self-host bootstrap writes the selected track into `.mos-updater/config.json` inside the repo checkout so later updater actions can use the same mode.
- Self-host bootstrap also writes `deploy/vps/docker-compose.selfhost.yml` so Suite Manager can reach the host updater service on future starts and updates.

The self-host bootstrap now also installs a host-local MOS update agent service:

- systemd service name: `mos-update-agent.service`
- local Unix socket: `/run/mos-update-agent/agent.sock`
- state directory: `/var/lib/mos-update-agent`
- bearer token file: `/etc/mos-update-agent/auth.token`
- local helper command: `mos-update`

This service is the intended bridge between future managed-update UI actions and the host-owned update execution path.

The updater does not run automatically in the background.
