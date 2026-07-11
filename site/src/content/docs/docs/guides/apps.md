---
title: Install and manage apps
description: How to install apps from the My Own Suite catalog, connect them to each other, and manage their lifecycle — including what uninstalling really deletes.
---

Everything you host lives in the **Apps** screen of Suite Manager: a catalog of vetted open-source applications, each packaged so that installing takes a couple of clicks.

## Installing an app

1. Open **Suite Manager → Apps** and browse or search the catalog. Each app's card shows what it replaces, how involved the setup is, and roughly how heavy it is on your machine; the detail view adds features, privacy notes, and related apps.
2. Click through to **install**. Some apps need nothing from you at all. Others ask for one or two inputs — typically an admin email (pre-filled with your owner email) and a password. Secrets an app needs internally are generated for you and stored on the server, never shown or asked for.
3. Wait for the install to finish. Under the hood, MOS builds the app from its pinned recipe, starts it, wires up its web address, and adds a tile to your Home dashboard.

Your new app is reachable at its own address — `http://<app>.<your-domain>/`, so for example `http://seafile.mos.home/` — and from its dashboard tile.

:::tip[Home network note]
If you used the quick hosts-file approach from the [own-hardware install guide](/docs/install/own-hardware/), add a line for each new app (`<server-ip> seafile.mos.home`). With a wildcard DNS rule (`*.mos.home`), new apps just work.
:::

**Setup guides.** Apps that need steps on your other devices — like pointing your phone's calendar at [Radicale](/docs/apps/radicale/) — include a built-in guide in their detail view, with copyable values and per-device instructions. Guides track whether you've completed or skipped them.

## Connecting apps to each other

Some apps become more than the sum of their parts when connected — the classic pair being [Seafile](/docs/apps/seafile/) and [ONLYOFFICE](/docs/apps/onlyoffice/): connect them and every document in your file cloud opens for editing right in the browser.

When two installed apps can work together, the Apps screen offers a **connect** action. MOS handles the exchange — shared secrets, network access, configuration — and records the relationship, so you never copy keys between admin panels. Disconnecting or uninstalling either side updates the relationship honestly instead of leaving a half-connected state.

## Health, and the app lifecycle

Every installed app shows a live health indicator, verified against the actual running state — if an app crashes, its tile and detail view say so rather than pretending all is well. From the detail view you can:

- **Restart** — the first fix for a misbehaving app.
- **Stop / disable** — non-destructive. The app goes offline but keeps all data, settings, and its dashboard tile arrangement. Enable it again any time.
- **Uninstall** — **destructive.** This removes the app *and its data*: containers, web address, dashboard tile, stored settings, secrets, and the app's data volumes. The confirmation dialog spells this out. If there is any chance you'll want the data again, run a [backup](/docs/guides/backup-restore/) first.

## Where your data actually lives

Each app keeps its data in dedicated storage volumes on your server, named and owned by MOS. Whole-suite [backups](/docs/guides/backup-restore/) capture every one of them automatically — you never need to know an individual app's layout.
