---
title: Customize your Homepage
description: Make the My Own Suite Home dashboard your own — add links and home-network services with the guided dialog, or edit the configuration directly.
---

The Home dashboard is the page your household actually lives on, so it should look the way *you* want. Everything here happens in **Suite Manager → Customize**.

## The guided way: "Add to Homepage"

The **Add to Homepage** dialog covers the common cases without touching any configuration:

- **A website or shortcut** — any link you want on the dashboard: your webmail, the school portal, a favorite site.
- **An app on your home network** — something else already running in your house (a printer's admin page, a NAS, Home Assistant). Give it a name and its address and it becomes a first-class tile.

Tiles for apps installed through MOS appear automatically and stay correct on their own — when your suite's domain changes (say, after [setting up HTTPS](/docs/guides/https-domain/)), MOS-managed tiles update themselves. Links you added by hand are yours: MOS never rewrites them.

## The power-user way: edit the configuration

The dashboard is driven by a small set of human-readable YAML files (the [Homepage](https://gethomepage.dev/) project's format), and Customize gives you a direct editor for them — services, bookmarks, settings, and widgets.

Guardrails are built in:

- Every save is **validated first** — a typo gets a clear error instead of a broken dashboard.
- Changes apply through a checkpointed pipeline that keeps recent good versions, so a bad state can be rolled back.
- MOS-managed entries and your hand-written entries coexist; your edits to your own entries are preserved.

Widgets work too — install [Radicale](/docs/apps/radicale/) and its calendar widget can show your upcoming events right on the dashboard.

## A good rhythm

Start by just installing apps and letting tiles appear. Once the dashboard is earning its keep, spend ten minutes in Customize: group things the way your family thinks about them ("Photos", "Documents", "House"), add the three external links everyone always needs, and stop. A dashboard you don't have to think about is the goal.
