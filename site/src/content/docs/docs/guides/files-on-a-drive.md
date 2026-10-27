---
title: Your files on a drive
description: Apps like Jellyfin keep their library on a drive you plug into the server. What goes on the drive, what goes in your backups, and how both come back on a new server.
---

Some apps work on files you already have: the films Jellyfin plays, the photos Immich can show from a folder. MOS keeps those on a drive you plug into the server, not on the server's own disk. You fill the drive from any computer, and the app finds what you put there.

## Two kinds of things, kept safe two ways

Your server holds two kinds of things, and MOS protects them differently.

**What an app makes** — accounts, settings, the catalog Jellyfin built from your films, the notes you wrote — lives in the app's own storage on the server, and every [backup](/docs/guides/backup-restore/) carries all of it.

**The files you already had** — the films, the photo folders — live on your drive. They are not in your backups: the drive is their home, and the copy of it you keep somewhere else is their backup. [Keeping copies](/docs/guides/keeping-copies/) explains why one copy is never enough.

Together, this is what lets a server be replaced. Install MOS on a new server, restore the backup, plug in the drive, and the app is back with its settings and its library. The drive is not tied to one server: any MOS server you plug it into reads its files.

## Which drives

A drive formatted as exFAT, NTFS or FAT32 — the way portable drives come, readable by Windows, macOS and Linux alike. The drive MOS runs from cannot hold app files, and neither can a drive formatted for Linux, though that one can hold backups.

## Installing an app with a drive

An app that needs a drive, like Jellyfin, says **Requires an extra storage device** until one is plugged in; then its install asks which drive. An app that can use a drive but does not need one, like Immich, offers it in its settings. MOS makes the app's folders on the drive, such as `MOS-files/apps/jellyfin/Movies`, and the app starts with them already set up — no library to configure.

Open **Settings → Storage** to see every drive plugged in and the storage you rent online, how full each is and what is on it. MOS opens a drive the moment it is plugged in, so a drive it was never told about — one from an old server, say — shows its app folders and any backups left on it straight away, before you pick it for anything.

## Filling the drive

Copy files into those folders from any computer: plug the drive into your laptop, copy, plug it back into the server. MOS mounts it again and the app picks up what is new.

Or add files from your browser. **Browse files** on the drive in Settings → Storage shows everything on it — what MOS manages in color, the rest greyed to look at and download. Open `MOS-files`, then drag files onto the page to add them, make folders, rename, move within the drive, and delete. Big files arrive a piece at a time, so nothing half-added is ever left behind: after a dropped connection or a reload, drop the same file again and MOS asks the drive how far it got and carries on from there. Leaving the page while files are still arriving stops them, and MOS asks first.

## Unplugging it

**Eject** in Settings → Storage pauses the apps on the drive and says when it is safe to unplug; plugging it back in starts them again.

A drive pulled without ejecting, or cut off by a power failure, opens read-only when it returns, so your apps keep showing its files, and **Check drive** repairs it in seconds without unplugging it. The start page, the app's own page and Settings say when a drive needs a check, could not be opened, is not connected or was ejected.

## Uninstalling an app

Uninstalling never touches your files. The app's folders stay on the drive, listed greyed under `apps` in the files screen, to browse or delete whole when you are sure.

## Backups and the drive

The same drive can hold your backups too, under `MOS-backups`, beside the app folders. MOS warns when you pick it, because one drive would then carry both the library and the backups of the apps that use it, and losing it would lose both. A separate drive for backups is the safer habit; [Keeping copies](/docs/guides/keeping-copies/) has the rest.
