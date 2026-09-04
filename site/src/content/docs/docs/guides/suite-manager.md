---
title: Suite Manager, your control room
description: A tour of Suite Manager — the browser control room where you install apps, customize your dashboard, back up, update, and configure My Own Suite.
---

Suite Manager is where you run your suite. It lives at `home.<your-domain>/suite-manager/`, shares its sign-in with your Home dashboard, and is designed around one promise: **you should never need a terminal for everyday ownership.**

## The menu, top to bottom

- **Dashboard** — jumps back to your Home dashboard, the tile page the whole household uses.
- **Apps** — the app store and the lifecycle of everything you install: install from the catalog or your own repository, connect apps to each other, update them one by one, restart, disable, uninstall, and per-app setup guides. See [Install and manage apps](/docs/guides/apps/).
- **Customize** — shape your Home dashboard: add links and home-network services, rearrange groups, or edit the underlying configuration directly. See [Customize your Homepage](/docs/guides/customize-homepage/).
- **Backup** — manual whole-suite backups to an attached external drive on own hardware or a mounted block-storage volume on a cloud server, plus restore. See [Back up and restore](/docs/guides/backup-restore/).
- **Updates** — check for and apply updates to the *platform*, and choose your update track. Individual apps update from the Apps screen instead. See [Keep your suite up to date](/docs/guides/updates/).
- **Settings** — the [real domain + HTTPS setup](/docs/guides/https-domain/) for self-hosted installs, and a plain-language summary of recent security activity on your server over the last 30 days.
- **Sign out.**

## Conventions worth knowing

**Plain language first, details on demand.** Every screen explains its state in normal words. The raw material — logs, generated configuration, IDs, technical output — is there when you want it, but it stays out of the way until you ask: turn on **Show technical controls** in **Settings → Technical controls** and an **Advanced details** panel appears wherever there is something to show. It is off by default, it is remembered for your account rather than for one browser, and turning it off again hides those panels without changing anything else. When a screen is reporting a failure it shows its diagnostics either way, so you always have something to paste into a bug report.

**One place to configure an app.** **Install** opens the same review dialog for every app: whatever that app needs from you, the web address it will get, and whether to add a shortcut to Homepage. Most apps need nothing and say so. The same dialog reopens as **Settings** in the app's menu once it is running.

**What you were asked for at install stays as it is.** In **Settings** those values are shown but cannot be edited. Apps read most of them once, when they first start — an admin password creates your account and is then the app's to manage — so changing them in MOS afterwards would either do nothing or leave the app unable to reach its own data. Change them from inside the app itself.

**Settings an app never asked for.** Some apps read settings that MOS does not offer at install — an account credential for a service you use, a switch the project documents but MOS has no reason to know about. With technical controls on, **Advanced details** inside an app's **Settings** dialog lets you give the app those values yourself. It is the one place in Suite Manager where a wrong value can stop an app starting, so MOS refuses names it manages itself, hides values you mark as hidden, and — if the app does not come back after the change — puts your previous settings back on its own and tells you.

**Nothing happens silently.** Actions that change your machine show progress while they run and report honestly when something fails. Destructive actions (uninstalling an app, restoring a backup) require explicit confirmation and say exactly what will be lost.

**Screens degrade honestly.** Each feature is backed by a small dedicated service on the machine (see [Host agents](/docs/reference/host-agents/)). If one is unreachable, its screen says so plainly — for example *"The host backup service is not running"* — instead of failing mysteriously. Running an [update](/docs/guides/updates/) refreshes all of these services; that resolves most such messages.

## Owner account security

Repeated failed sign-in attempts receive progressively longer, temporary delays. This slows online password guessing without permanently locking the single owner out. Multi-factor authentication and passkeys are not available yet, so use a unique password from a password manager and do not reuse it for an app or another service.

## Where Suite Manager ends

Suite Manager deliberately does **not** manage things *inside* your apps — Seafile's libraries, Immich's albums, Vaultwarden's vaults all belong to the apps themselves and their own admin tools. Suite Manager runs the platform *around* them: installing, connecting, routing, backing up, and updating.
