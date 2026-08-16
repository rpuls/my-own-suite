# Prebuilt disk image (proof of concept)

Roadmap theme **H1**. Built in parallel with the shipping ISO installer, which is
untouched and still the supported path. The release pipeline builds and boot-tests
the image, but uploads it unlisted: nothing links to it and the release notes do
not mention it.

Proven end to end on 2026-08-14 — baked, flashed, and installed on the HP
EliteDesk 705 G3 that triggered the theme.

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
.\image-builder\build-image.ps1                    # seed -> iso -> bake -> convert -> verify
.\image-builder\build-image.ps1 -Stage verify      # re-run one stage while iterating
```

Individual stages: `seed`, `iso`, `bake`, `convert`, `verify`, `inspect`, `clean`.
`inspect` mounts the built image and prints the bake logs; use it when a bake fails.

On Linux and in CI, `bake.sh` is the same pipeline against QEMU/KVM and OVMF:

```bash
./image-builder/bake.sh all            # or: seed | iso | bake | convert | verify
```

Both drivers call the same `render-bake-seed.cjs`, `extract-image.sh`,
`shrink-image.sh` and `check-target.sh`, so a locally built image and a CI built
image come off one pipeline rather than two that drift.

The `disk-image` job in `.github/workflows/release.yml` runs it on every tag. It
applies the same publishability gates the ISO gets — the seed must pin the tag,
must not bake a password, must not enable the lab reset agent — then **boots the
compressed artifact it is about to upload and refuses to publish it unless it
passes the verify checks below**. It publishes under a `disk-image/` prefix and is
not mentioned in the release notes, because the ISO is still the supported
download. It is deliberately not a dependency of the `publish` job: an
experimental image must not be able to hold back a release.

| Flag | Default | Notes |
| --- | --- | --- |
| `-RepoRef` | `staging` | The bake VM clones this from GitHub, so it must be pushed. |
| `-DiskSizeGB` | `16` | Working room for the bake. The published image is shrunk to its contents, and the target grows to fill its disk on first boot. |
| `-BakeTimeoutMinutes` | `120` | Install plus bootstrap plus finalize. |
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

## What verify proves

The `verify` stage boots the **published** image — after the shrink and the GPT
rewrite, which is where a boot-breaking mistake would actually live — on a disk
deliberately larger than the image, because nobody installs onto a disk the exact
size of the download.

It fails unless Suite Manager answers 200, then shuts the machine down cleanly and
runs `check-target.sh` over the disk it leaves behind. That second half exists
because the interesting parts of a first boot are sized against a disk the build
cannot know, so they are not checkable on the artifact:

- the root filesystem grew to fill the disk
- at least 2 GB is still free afterwards
- a swapfile exists and is in `fstab`
- cloud-init stayed disabled, and the machine generated its own SSH host keys

The free-space check is not hypothetical. The first version of `mos-grow-root`
created a flat 2 GB swapfile regardless of what was left, filled the root
filesystem to 100%, and still booted and served traffic for a few minutes before
returning 502.

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

Written to a USB stick with Rufus (DD mode) or balenaEtcher, and booted:

- `mos-self-install` sees it is running from removable media, finds the single
  internal disk, asks for `YES`, copies itself over, expands to fill the disk, and
  asks you to remove the stick and reboot.
- On the internal disk it sees non-removable media and does nothing, so the same
  image is both the installer and the installed system.
- `mos-ssh-hostkeys`, `mos-grow-root` and `mos-first-boot` give the machine its own
  identity, its full disk, and its own server login.
- `mos-first-boot` then writes the completion banner to `/etc/issue.d/`. It leads
  with the DNS override for `home.mos.home` and points at the docs for how; a
  login screen is the wrong place for a guide. It does not yet offer the second
  door below, which needs no override at all — putting both on the banner and the
  success screen, with a probe for the one that works, is roadmap **H7**.

## Two ways in, and one of them needs nothing configured

The image serves both doors for the life of the install, and the owner picks
neither — they are aliases for the same Suite Manager.

- `http://home.mos.home` needs one wildcard `*.mos.home` rule in the owner's own
  Pi-hole, AdGuard, Unbound or OpenWRT, or a hosts-file line on the computer they
  browse from. Nothing leaves the house, and it does not depend on MOS.
- `http://home.<lan-ip-with-dashes>.local.myownsuite.org` needs nothing at all.
  The MOS-operated nameserver in `infrastructure/nameserver/` answers it with the
  encoded address, so a phone on the same wifi opens the suite with no
  configuration by anyone. `192.168.1.42` becomes `192-168-1-42`, and every
  installed app gets the same treatment: `seafile.192-168-1-42.local.myownsuite.org`.

The Caddyfile baked into this image matches the second name by pattern rather than
naming a host, because a disk image cannot know the address the machine it boots
on will be given.

Both doors close in favour of a real domain: applying one with DNS-01 in Suite
Manager replaces the Caddyfile with the HTTPS one, and plain HTTP on a globally
resolvable name stops being served.

## Known gaps

- **The name carries the LAN IP, so a DHCP move breaks every saved bookmark and
  every generated app route.** Suite Manager itself survives it — its site block
  matches any private address rather than one — but the apps do not: their routes
  name one exact host and are only re-rendered when the app is next applied.
  Re-rendering them when the machine's address changes is deliberately not built
  yet, so **a DHCP reservation is a step in the install, not advice after it.**
  The console banner prints the address the machine actually has, which is where
  an owner finds out it moved.
- **DNS-rebinding protection refuses these answers on some networks.** Fritz!Box,
  OpenWRT, pfSense, Pi-hole and AdGuard ship it on, and whether it works can
  differ *per device on one network* because Private Relay and Private DNS route
  lookups past the router. That mostly hits owners who would take the first door
  anyway. Detecting it from the browser and offering the other door is roadmap
  **H7**; `infrastructure/nameserver/README.md` has the measurements.
- **UEFI only.** One image means one layout, and that layout is GPT + ESP. The HP
  EliteDesk that triggered this work appeared unable to UEFI-boot a USB stick
  across four attempts, which nearly justified an MBR image; it turned out to be
  stale firmware state, and **Apply Factory Defaults** cleared it with every
  setting already correct. Suspect NVRAM before suspecting the layout.
- **Single internal disk only.** With more than one it refuses rather than guesses.
  Roadmap H4 decides what the confirmation should look like.
- `mos-self-install` copies a mounted root filesystem after a best-effort
  read-only remount and repairs the copy with `e2fsck -fy`. Quiescing it properly
  is a real fix, not a PoC one.
- After a self-install the stick and the internal disk carry identical filesystem
  UUIDs, because one is a byte copy of the other. It asks for the stick to be
  removed before rebooting, which is enough in practice, but leaving it in means
  the initramfs picks between two disks that claim to be the same one.
  Randomising the target's UUIDs — and updating its `fstab` and `grub.cfg` to
  match — is the real fix.
- `mos-self-install` is still untested in CI, and structurally cannot be tested
  there: neither Hyper-V nor QEMU presents a disk as removable, so the guard that
  makes the image safe to boot on a daily driver is the one thing no automated run
  exercises. `AGENTS.md` rules out adding a bypass to make it testable. It has run
  correctly on real hardware exactly once.
