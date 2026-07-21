---
title: Keep your suite up to date
description: How updates work in My Own Suite — the platform and your apps update separately, nothing happens without your say-so, and a failed update puts things back.
---

Updates in My Own Suite come in two kinds, and it's worth knowing which is which:

- **Platform updates** change MOS itself — Suite Manager, the host services, the plumbing. Managed from **Suite Manager → Updates**.
- **App updates** change one installed app. Managed from that app in **Suite Manager → Apps**, on its own schedule, without waiting for a MOS release.

They are deliberately separate. Your password manager shouldn't have to wait for us to ship a version of MOS before it can get a security fix.

Neither kind happens on its own. MOS checks for updates in the background and tells you what it found; applying anything is your decision. No SSH, no package managers, no surprises.

## App updates

Your server periodically checks a signed catalog of app packages — every few hours — and compares what's available against what you actually have installed. When something newer exists, that app gets an **Update available** badge in the Apps screen.

Open it and you get a plain-language summary of what you're about to change before you commit to anything:

- The version you're on and the version you'd move to.
- Anything that would break, or that needs a decision from you.
- New settings the app now requires — asked for up front, not halfway through.
- Whether the [privacy assessment](/docs/privacy/how-we-assess/) changed, and whether the app is asking for more access than it has today.

The raw comparison sits behind **Advanced details** if you want it. When you're happy, you press the button.

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

The **Updates** screen shows your update **track**, the version you're running, the newest one available, and whether the updater is ready. **Check again** refreshes; **Update now** applies. You get live progress and a summary of what's changing, with the full technical logs behind **Advanced details**.

### Tracks

- **Stable releases** — tagged, release-noted versions. This track is visible but **not yet installable**: MOS cannot apply tagged stable releases until the first one ships, so the Updates screen keeps it read-only and won't start an update from it.
- **Main branch** — reviewed changes that have been promoted to the project's default branch. Fresh installs run code from this branch and default to this track; it's the right choice for most installs while MOS is pre-1.0.
- **Staging branch** — the integration branch, where changes land for testing before promotion to main. Pick this only if you want new features earlier and accept more churn.

Until the first stable release ships, managed updates apply from the Main and Staging branch tracks.

### What a platform update actually does

It fetches the new code, rebuilds what needs rebuilding, and refreshes **all** of the platform's own services on your machine, including the small host services that power backups, HTTPS, and app management. A MOS update never half-applies: the platform treats "some parts updated, some didn't" as a bug, not a state you should have to manage.

**Your installed apps are not touched.** Each app runs from a snapshot of the exact package it was installed with, so a platform update cannot quietly rebuild your apps from newer files, and nothing needs re-applying afterwards. When an app has a newer version available, it says so itself, in Apps, and you decide.

## Before you update

Take a [backup](/docs/guides/backup-restore/). Updates are designed to be safe and honest about failures — but "I have last week's backup" turns any surprise into an inconvenience. This matters most for app updates that migrate data, which the update summary will warn you about.

If the screen reports the updater itself as unavailable, see [Host agents](/docs/reference/host-agents/) for how the platform services are laid out and restarted.
