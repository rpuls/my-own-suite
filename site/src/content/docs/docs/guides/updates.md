---
title: Keep your suite up to date
description: How managed updates work in My Own Suite — checking for updates, choosing a track, and what an update actually does to your machine.
---

Updates are managed from the browser in **Suite Manager → Updates**. No SSH, no package managers — and no silent auto-updates either: *you* decide when your suite changes.

## The Updates screen

The screen shows your update **track**, the version/commit you're running, the newest one available, and whether the updater is ready. **Check again** refreshes; **Update now** applies. While an update runs you get live progress and a summary of what's changing, with full technical logs behind **Advanced details**.

## Tracks

- **Stable releases** — tagged, release-noted versions. The right choice once you depend on your suite.
- **V2 lab branch** — the active development branch, with changes arriving continuously. Fresh installs currently default to this track while MOS is pre-1.0; it's the version these docs describe, but it moves fast.

You can switch tracks from the same screen.

## What an update actually does

A managed update fetches the new code, rebuilds what needs rebuilding, and — importantly — refreshes **all** the platform's own services on your machine, including the small host services that power backups, HTTPS, and app management. A MOS update never half-applies: the platform treats "some parts updated, some didn't" as a bug, not a state you should manage.

Your installed apps and their data are untouched by platform updates. When an update changes an app's own packaging, the Updates screen tells you that the app needs a restart or re-apply — it won't happen behind your back.

## Before you update

Take a [backup](/docs/guides/backup-restore/). Updates are designed to be safe, and honest about failures — but "I have last week's backup" turns any surprise into an inconvenience.

If the screen reports the updater itself as unavailable, see [Host agents](/docs/reference/host-agents/) for how the platform services are laid out and restarted.
