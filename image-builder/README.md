# Prebuilt disk image (proof of concept)

Roadmap theme **H1**. Built in parallel with the shipping ISO installer, which is
untouched and still the supported path. Nothing here is published yet.

## Why

The ISO installer runs Ubuntu's installer on the target machine, so the partition
table and bootloader are decided there, mirroring whichever mode the firmware
happened to boot the USB stick in. On 2026-08-14 that produced a perfect install
and an unbootable machine on an HP EliteDesk 705 G3: the stick booted legacy, so
curtin wrote GPT plus a BIOS boot partition, and HP's CSM refuses to boot GPT.
Nothing reported an error — the install log ended `DONE, error: null`.

A prebuilt image moves that decision to build time. One layout, decided once, in
CI, identical on every machine.

## What it does not change

The cloud one-line installer and the DigitalOcean path are untouched. The image is
baked by running the *existing* `renderBootstrapShell()` output inside a VM, via
the *existing* autoinstall seed, so there is one definition of a MOS machine and
this is a second way of packaging it — not a second definition.

`render-bake-seed.cjs` calls `renderSeed()` from
`scripts/installers/render-hyperv-usb-seed.cjs` and appends a finalize hook. It
edits nothing under `scripts/` or `infrastructure/`.

## Building

Requires Hyper-V (this machine has no `/dev/kvm` inside Docker Desktop, so QEMU
would emulate and take hours) and Docker for the ISO remaster.

```powershell
.\image-builder\build-image.ps1                      # seed -> iso -> bake -> convert -> verify
.\image-builder\build-image.ps1 -Stage finish        # once verify looks right
```

Individual stages: `seed`, `iso`, `bake`, `convert`, `verify`, `finish`, `clean`.

| Flag | Default | Notes |
| --- | --- | --- |
| `-RepoRef` | `staging` | The bake VM clones this from GitHub, so it must be pushed. |
| `-DiskSizeGB` | `12` | The image is exactly this big; the target grows to fill its disk on first boot. |
| `-BakeTimeoutMinutes` | `90` | Install plus bootstrap plus finalize. |
| `-DebugBake` | off | Bakes the lab profile's fixed password so a failed finalize can be logged into. Never publish one. |

Output lands in `image-builder/.work/out/`, which is git-ignored.

## What the bake does

1. Boots the remastered ISO in a Gen 2 (UEFI) VM and installs Ubuntu with the
   published seed, producing GPT + ESP.
2. cloud-init runs the MOS control-plane bootstrap — the same script the cloud
   installer runs — so docker, Node, Caddy, the repo checkout, `npm ci`,
   `build:client`, the Caddy build and the Homepage image are all baked in. Today
   all of that is downloaded on the target at first boot, which is the most
   fragile part of the product.
3. The VM reboots and `mos-image-finalize` turns that one machine into an image:
   full-driver initramfs, hardware-independent netplan, bootloader written to the
   removable-media fallback path, cloud-init disabled, SSH host keys and
   machine-id removed, server login reset so each machine generates its own.
4. It powers off. The host converts the disk with `qemu-img`, shrinks the
   filesystem and root partition to the actual contents, truncates the file, and
   compresses it with `xz`. The target grows the filesystem back on first boot.

## Size

The download is what deters people, so it is a first-class constraint — and the
Cloudflare R2 free tier is 10 GB total with two images kept per release.

Measured on the first bake, before any of this was done: 16 GB file, 8.0 GB used.
`/usr` 2.9 GB, container images under containerd 2.7 GB, **`/swap.img` 2.1 GB**,
`/opt/mos` 182 MB, and 6.3 GB of empty space that existed only because the bake
disk was 16 GB.

So the build now removes the swapfile (`mos-grow-root` makes a new one on the
target, sized to a disk the build cannot know), prunes the container build cache,
shrinks to contents plus `-SlackMB` headroom, and ships `.img.xz`.

For comparison, Home Assistant OS is a few hundred MB because it is a Buildroot
appliance rather than a distro, **and** because it downloads its application on
first boot — the exact thing this change exists to stop doing. Baked containers
are the cost of an offline first boot, and they are worth it.

## What the image does on the target

Written to a USB stick with balenaEtcher and booted:

- `mos-self-install` sees it is running from removable media, finds the single
  internal disk, asks for `YES`, copies itself over, expands to fill the disk, and
  asks you to remove the stick and reboot.
- On the internal disk it sees non-removable media and does nothing, so the same
  image is both the installer and the installed system.
- `mos-ssh-hostkeys`, `mos-grow-root` and `mos-first-boot` give the machine its own
  identity, its full disk, its own server login, and a console banner with its LAN
  address.

## Known gaps

- **Reaching it in a browser is still a manual step, and this does not fix that.**
  `renderCaddyfile()` — the local, non-cloud Caddyfile — serves exactly one site
  block, `http://$MOS_HOME_HOST`, so `home.mos.home` is the only address that
  reaches Suite Manager. Nothing on an ordinary LAN resolves that name, so every
  own-hardware installer has to edit a hosts file or configure router DNS before
  they can open the thing they just installed. A prebuilt image removes the boot
  failure and leaves this one untouched. Adding a catch-all site block so the
  machine also answers on its bare LAN IP would remove it, and would not touch the
  cloud path, which uses `renderPublicCloudCaddyfile()` instead. That is a change
  to shared code, so it is a decision rather than something this PoC took.
- **UEFI only.** One image means one layout, and that layout is GPT + ESP. The HP
  EliteDesk that triggered this work cannot UEFI-boot a USB stick at all, so it
  needs a BIOS update or a different layout decision — see roadmap H1.
- **Single internal disk only.** With more than one it refuses rather than guesses.
  Roadmap H4 decides what the confirmation should look like.
- Hyper-V only; no CI job yet. The bake is deliberately a plain autoinstall seed
  plus a shell script so it ports to QEMU/KVM on a GitHub runner unchanged.
- `mos-self-install` copies a mounted root filesystem after a best-effort
  read-only remount and repairs the copy with `e2fsck -fy`. Quiescing it properly
  is a real fix, not a PoC one.
- After a self-install the stick and the internal disk carry identical filesystem
  UUIDs, because one is a byte copy of the other. It asks for the stick to be
  removed before rebooting, which is enough in practice, but leaving it in means
  the initramfs picks between two disks that claim to be the same one.
  Randomising the target's UUIDs — and updating its `fstab` and `grub.cfg` to
  match — is the real fix.
- `mos-self-install` has still never run. Hyper-V cannot present a disk as USB, so
  it cannot be exercised in a VM, and `AGENTS.md` rules out adding a bypass to
  make it testable. Its first execution will be on real hardware.
