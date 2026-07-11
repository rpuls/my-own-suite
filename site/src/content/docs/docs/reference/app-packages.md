---
title: App packages
description: How My Own Suite apps are defined — self-contained packages with a manifest as the single source of truth for setup, runtime, routing, and docs.
---

Every app in the catalog is a self-contained **package** in the repository — one folder under [`apps/`](https://github.com/rpuls/my-own-suite/tree/main/apps) that fully describes the app:

```
apps/<app-id>/
├── manifest.json     # the single source of truth
├── Dockerfile        # primary service (Dockerfile.<service> for extras)
├── icon.png
└── README.md         # the package's technical reference
```

There is no separate app registry, store database, or docs copy to keep in sync. The Suite Manager catalog, the landing-page catalog, the [Apps section of these docs](/docs/apps/), and the runtime itself all read the same manifests — add a valid package folder and it appears everywhere.

## The manifest

`manifest.json` declares everything the platform needs to present, install, run, and connect the app:

- **Identity** — `id`, `name`, `version`, `summary`, `category`, `icon`.
- **`catalog`** — presentation metadata: description, what the app `replaces`, feature list, setup-complexity and resource hints, privacy notes, tags, official links, related apps.
- **`setup`** — the install form, as data: typed fields (text/email/password) with labels, defaults, and required flags. Fields can be marked `generated` — MOS creates the secret itself and the user never sees a prompt.
- **`resources`** — the runtime shape: one or more services, each with its Dockerfile, internal port, environment (with `${secret.*}` / `${config.*}` / `${app.*}` interpolation), volumes, and dependencies. Multi-service apps (Seafile ships its own MySQL and Valkey) keep dependency containers internal-only.
- **`routes`** — the public hostname(s) Caddy should route, e.g. `seafile.<domain>`.
- **`homepage`** — the dashboard tile (group, name, description, icon), plus optional widgets.
- **`health`** — how the platform verifies the app is actually up.
- **`onboarding`** — optional post-install setup guides (steps, sections, copyable values) rendered in Suite Manager.
- **`exports` / `integrations`** — the capability system behind [app connections](/docs/guides/apps/): a provider exports a capability (ONLYOFFICE exports `documentEditor`), a consumer declares a slot for it (Seafile consumes one), and the platform can wire them together — secret grants, network attachment, config patching — without app-specific code in the core.

## Rules packages live by

- **No floating tags.** Base images in package Dockerfiles are pinned by immutable digest (`FROM image@sha256:…`); versions are bumped deliberately, reviewed, and released.
- **Dockerfiles live at the package root** (`Dockerfile`, `Dockerfile.<service>`), and published paths are treated as stable API.
- **The README is the technical reference** — environment variables, volumes, health endpoints, project-specific patches. It's what renders under *Technical reference* on each [app docs page](/docs/apps/), so it is maintained next to the code it describes.

The full package contract — validation, lifecycle semantics, capability wiring — is specified in [`apps/README.md`](https://github.com/rpuls/my-own-suite/blob/main/apps/README.md) in the repository. If you're thinking about packaging an app: that spec plus any existing package as a template is the way in.
