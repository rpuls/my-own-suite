---
title: Install and manage apps
description: How to install apps from the My Own Suite catalog or your own repository, connect them to each other, keep them updated, and manage their lifecycle — including what uninstalling really deletes.
---

Everything you host lives in the **Apps** screen of Suite Manager: a curated catalog of open-source applications, each packaged by MOS so that installing takes a couple of clicks — and, if you want something that isn't in it, a way to bring your own.

## Installing an app

1. Open **Suite Manager → Apps** and browse or search the catalog. Each app's card shows what it replaces, how involved the setup is, and roughly how heavy it is on your machine; the detail view adds features, related apps, and its [privacy posture](/docs/privacy/how-we-assess/) — an A-to-D grade where we've assessed the app, or an honest *Not yet rated by MOS* where we haven't.
2. Click through to **install**. Some apps need nothing from you at all. Others ask for one or two inputs — typically an admin email (pre-filled with your owner email) and a password. Secrets an app needs internally are generated for you and stored on the server, never shown or asked for.
3. Wait for the install to finish. Under the hood, MOS builds the app from its pinned recipe, starts it, wires up its web address, and adds a tile to your Home dashboard.

**That recipe is then yours.** MOS keeps a verified copy of the exact package it installed, and your app runs from that copy from then on. Nothing we change in the repository later can reach in and alter the app you're already running — it changes only when you choose to update it.

Your new app is reachable at its own address — `http://<app>.<your-domain>/`, so for example `http://seafile.mos.home/` — and from its dashboard tile.

:::tip[Home network note]
If you used the quick hosts-file approach from the [own-hardware install guide](/docs/install/own-hardware/), add a line for each new app (`<server-ip> seafile.mos.home`). With a wildcard DNS rule (`*.mos.home`), new apps just work.
:::

**Setup guides.** Apps that need steps on your other devices — like pointing your phone's calendar at [Radicale](/docs/apps/radicale/) — include a built-in guide in their detail view, with copyable values and per-device instructions. Guides track whether you've completed or skipped them.

## Connecting apps to each other

Some apps become more than the sum of their parts when connected — the classic pair being [Seafile](/docs/apps/seafile/) and [ONLYOFFICE](/docs/apps/onlyoffice/): connect them and every document in your file cloud opens for editing right in the browser.

When two installed apps can work together, the Apps screen offers a **connect** action. MOS handles the exchange — shared secrets, network access, configuration — and records the relationship, so you never copy keys between admin panels. Disconnecting or uninstalling either side updates the relationship honestly instead of leaving a half-connected state.

## Bringing your own app

If the catalog doesn't have what you want, paste a GitHub repository URL into the Apps search. MOS fetches it, checks it, and shows you a preview card before anything is installed — what the package is, and what it's asking for: which web addresses, which storage, which other apps it wants to reach, all in plain language.

These apps are labelled **External · Unverified** everywhere they appear, and stay labelled that way after install. It means what it says: we haven't reviewed the package and we won't imply otherwise. MOS constrains what an unverified package may ask for — no privileged containers, no Docker socket, no host filesystem, no reaching into another app's secrets — and it can't borrow an official app's name or icon to look legitimate.

The part to weigh honestly: installing builds the package from the publisher's own instructions, which run on your server with network access before any of those runtime limits apply. You're trusting that publisher. MOS's job is to make sure you know that at the point you decide.

Once installed, an external app is managed exactly like any other — restart, stop, uninstall, backup, and updates all work the same way.

## Keeping apps updated

Apps update independently of MOS itself, so a fix for one app never waits on a MOS release. Your server checks a signed catalog every few hours, and an app with something newer gets an **Update available** badge right in the Apps screen.

You always see what would change before it changes — versions, anything that would break, new settings the app now needs, and whether its privacy assessment or the access it wants has moved. Then you decide. MOS builds the new version before stopping the old one, and if the update fails it puts the app back or tells you exactly what state you're in.

See [Keep your suite up to date](/docs/guides/updates/) for how this works and where its limits are.

## Health, and the app lifecycle

Every installed app shows a live health indicator, verified against the actual running state — if an app crashes, its tile and detail view say so rather than pretending all is well. From the detail view you can:

- **Update** — when a newer version is available, with a summary of what changes first. See [above](#keeping-apps-updated).
- **Restart** — the first fix for a misbehaving app.
- **Stop / disable** — non-destructive. The app goes offline but keeps all data, settings, and its dashboard tile arrangement. Enable it again any time.
- **Uninstall** — **destructive.** This removes the app *and its data*: containers, web address, dashboard tile, stored settings, secrets, and the app's data volumes. The confirmation dialog spells this out. If there is any chance you'll want the data again, run a [backup](/docs/guides/backup-restore/) first.

## Where your data actually lives

Each app keeps its data in dedicated storage volumes on your server, named and owned by MOS. Whole-suite [backups](/docs/guides/backup-restore/) capture every one of them automatically — you never need to know an individual app's layout.
