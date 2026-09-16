---
title: Keep your suite up to date
description: How updates work in My Own Suite — the platform and your apps update separately, nothing happens without your say-so, and a failed update puts things back.
---

Updates in My Own Suite come in two kinds, and it's worth knowing which is which:

- **Platform updates** change MOS itself — Suite Manager, the host services, the plumbing. Managed from **Suite Manager → Updates**.
- **App updates** change one installed app. Managed from that app in **Suite Manager → Apps**, on its own schedule, without waiting for a MOS release.

They are deliberately separate. Your password manager shouldn't have to wait for us to ship a version of MOS before it can get a security fix.

Neither kind happens on its own. MOS checks for updates in the background and tells you what it found; applying either through Suite Manager is your decision and needs no SSH or package manager.

Underneath both sits Ubuntu, and MOS keeps that patched too — automatically, security fixes only, with restarts left to you. See [Keeping the operating system patched](#keeping-the-operating-system-patched) below.

## App updates

Your server periodically checks a signed catalog of app packages — every few hours — and compares what's available against what you actually have installed. When something newer exists, that app gets an **Update available** badge in the Apps screen.

Open it and you get a plain-language summary of what you're about to change before you commit to anything:

- The version you're on and the version you'd move to.
- Anything that would break, or that needs a decision from you.
- New settings the app now requires — asked for up front, not halfway through.
- Whether the [privacy assessment](/docs/privacy/how-we-assess/) changed, and whether the app is asking for more access than it has today.

The raw comparison sits behind **Advanced details** if you have [technical controls](/docs/guides/suite-manager/) switched on. When you're happy, you press the button.

### What happens when you apply one

MOS builds the new version *before* it stops the old one, checks the new containers are actually healthy, and only then commits the change and reconciles your web addresses, dashboard tiles, and app connections as one transaction. Your data volumes are preserved throughout.

If something goes wrong, MOS puts the app back the way it was. Where that isn't fully possible — because the new version already migrated your data, say — it stops and tells you exactly which state you're in, and offers the action that resolves it: finish the update, or restore the previous version. It will not report success while your containers and your records disagree.

Two honest limits worth understanding:

- **Rolling back the software does not roll back your data.** If an app upgraded its own database on the way in, going back to the old version won't undo that. This is why the advice below exists.
- **An app can't be walked backwards.** MOS refuses to install an older version than the one you're running, so a repository that gets taken over or force-pushed cannot quietly move you back to a version with known holes. If you ever genuinely need to go back, it's a deliberate, separate action — not the same button as Update.

### Apps you brought yourself

An [external package](/docs/guides/apps/) installed from your own repository URL updates through the same machinery, with one difference: MOS doesn't track versions for sources it hasn't reviewed, so there's no badge. Its detail view offers **Check for updates** instead, which looks at the source you gave it.

### Security advisories

If we publish a problem affecting a version you're running, MOS flags it against your installed app — not against the newest version in the catalog, which you might not have. The advisory feed is signed, and Suite Manager warns you if it can't confirm a fresh one.

Be aware of what that warning means: no advisory is not proof that nothing is wrong. It means nothing has been published, or that your server couldn't check. Treat silence as *unknown*, not as *safe*.

## Platform updates

The **Updates** screen shows your update **track**, the version you're running, the newest one available, and whether the updater is ready. **Check again** refreshes; **Update now** applies. You get live progress and a summary of what's changing, with the full technical logs behind **Advanced details** — always there when an update fails, and with [technical controls](/docs/guides/suite-manager/) switched on the rest of the time.

### Tracks

- **Stable releases** — tagged, release-noted versions. Your server moves from one published release to the next, skipping the day-to-day changes in between. Fresh installs default to this track.
- **Main branch** — reviewed changes that have been promoted to the project's default branch, ahead of the next tagged release.
- **Staging branch** — the integration branch, where changes land for testing before promotion to main. Pick this only if you want new features earlier and accept more churn.

On the Stable track the screen compares your installed version against the newest published release; on a branch track it compares commits against that branch.

### What a platform update actually does

It fetches the new code, rebuilds what needs rebuilding, and refreshes **all** of the platform's own services on your machine, including the small host services that power backups, HTTPS, and app management. A MOS update never half-applies: the platform treats "some parts updated, some didn't" as a bug, not a state you should have to manage.

**Your installed apps are not touched.** Each app runs from a snapshot of the exact package it was installed with, so a platform update cannot quietly rebuild your apps from newer files, and nothing needs re-applying afterwards. When an app has a newer version available, it says so itself, in Apps, and you decide.

## Before you update

**A MOS update backs your whole suite up first.** Before it fetches anything it takes a full [backup](/docs/guides/backup-restore/) to wherever your automatic backups go. If that drive or bucket is not connected the update waits and starts by itself when it is back, and offers **Cancel update** or **Update without a backup** meanwhile; if the backup cannot be taken at all the update stops before changing anything. With no destination set for automatic backups there is nowhere to put one and the screen says so. **App updates are not covered by this** — take one yourself before an app update that migrates data, which the update summary will warn you about.

If the screen reports the updater itself as unavailable, see [Host agents](/docs/reference/host-agents/) for how the platform services are laid out and restarted.

## Keeping the operating system patched

Your server runs Ubuntu underneath MOS. MOS updates itself and your apps, and it keeps Ubuntu patched too — so a server that's been running for months isn't quietly behind on security fixes while the Updates screen says everything is current.

**What gets installed automatically:** security updates only, from Ubuntu's own security channel. These are fixes backported onto the version you already run — a patched OpenSSL is the same OpenSSL with the hole closed, not a new one. Ubuntu maintains that channel for this release until April 2029.

**What doesn't:** everything else. MOS never moves you to a new Ubuntu release. And the software your suite actually runs on — Docker, Caddy — doesn't come from that channel at all, so a security patch can't swap it out from under your apps. Those move when MOS updates, where they're tested together.

**Restarts are yours.** A few patches, kernel ones mostly, only take effect after a restart. MOS tells you when one is needed and leaves it at that. It will never restart your server on its own, so it can't interrupt you mid-upload. When you are ready, **Restart server** on the Updates screen does it; every app stops for a minute or two and comes back by itself.

**Where you see it:** on Updates, beside MOS and your apps — when it last checked, what's waiting, and when it last installed something.

**If a patch ever does break something,** MOS can hold it back on every server within the hour, without waiting for a MOS release. Worth knowing: a host that won't boot is reinstall-and-restore, not a rollback — your apps and data come back from your [backup](/docs/guides/backup-restore/), the operating system is installed fresh.

### If the server does not come back after a restart

A kernel patch does nothing until you restart, and Ubuntu keeps the previous kernel installed. If the machine stops booting after one, you can boot the old kernel: hold **Shift** (or press **Esc**) as it starts to get GRUB's menu, choose **Advanced options for Ubuntu**, and pick the kernel one version below the newest. On a VPS this is the provider's web console; on your own hardware it is a monitor and a keyboard. That gets you back to a running suite, from where MOS's own Updates screen and the diagnostics file will say what happened.

MOS also checks itself after every patch and after every restart: if the suite did not come back cleanly, the Updates screen says so rather than leaving you to discover it through an app that stopped working.

### What MOS cannot know

MOS has no telemetry, by design — it never reports anything about your server to the project. That means the project cannot learn from other people's servers that an Ubuntu patch is breaking things; it finds out when somebody says so. If a patch breaks your suite, the diagnostics file from **Settings** is what makes that report actionable, and the hold list above is how the answer reaches everyone else the same day.

*Under the hood: `unattended-upgrades` with `Allowed-Origins` restricted to `${distro_id}:${distro_codename}-security`, automatic reboot off. Suite Manager reads pending packages and `/var/run/reboot-required` through the read-only host agent. If you configured unattended-upgrades yourself, MOS reports what it found and leaves it alone.*
