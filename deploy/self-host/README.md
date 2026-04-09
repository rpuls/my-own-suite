# My Own Suite - Self-Host Tooling

This folder contains self-host-specific tooling and supporting assets.

Canonical user-facing documentation for the self-host flow lives here:

- [site/src/content/docs/deploy-on-your-own-hardware.mdx](../../site/src/content/docs/deploy-on-your-own-hardware.mdx)

Current scripts:

- [scripts/selfhost/bootstrap-ubuntu.sh](../../scripts/selfhost/bootstrap-ubuntu.sh)
- [scripts/selfhost-write-autoinstall.cjs](../../scripts/selfhost-write-autoinstall.cjs)
- [scripts/selfhost-write-cloudflared.cjs](../../scripts/selfhost-write-cloudflared.cjs)
- [scripts/selfhost-new-seed-disk.ps1](../../scripts/selfhost-new-seed-disk.ps1)
- [scripts/selfhost-build-installer-iso.cjs](../../scripts/selfhost-build-installer-iso.cjs)

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

Before running it, drop exactly one Ubuntu Server ISO into:

- `deploy/self-host/autoinstall/ubuntu-iso/`

What it does:

1. Generates fresh `user-data` and `meta-data`
2. Builds a small Docker-based ISO remaster environment with `xorriso`
3. Injects the MOS autoinstall seed into the Ubuntu ISO under `/autoinstall/`
4. Patches Ubuntu GRUB config to keep the normal Ubuntu boot path as the default and add a separate explicit `Install My Own Suite (ERASES DISK)` entry
5. Writes a single output ISO under `deploy/self-host/output/`

This is the intended direction for the HP mini PC flow because it removes the separate `CIDATA` disk from the final installation experience.
