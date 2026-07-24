---
title: App packages
description: How My Own Suite apps are defined — self-contained packages with a manifest as the single source of truth for setup, runtime, routing, and docs.
---

Every app in the catalog is a self-contained **package** in the repository — one folder under [`apps/`](https://github.com/rpuls/my-own-suite/tree/main/apps) that fully describes the app:

```
apps/<app-id>/
├── manifest.json        # the single source of truth
├── Dockerfile           # primary service (Dockerfile.<service> for extras)
├── privacy-review.json  # the MOS privacy assessment behind the posture grade
├── icon.png
└── README.md            # the package's technical reference
```

Two files at the root of `apps/` complete the picture: `catalog.json`, a deterministic index of every official package (path, package version, package digest, minimum MOS version, privacy status), and `advisories.json`, a feed of notices against package version ranges. Both carry a detached Ed25519 signature (`.sig`) that an installed machine verifies against a public key shipped in the MOS release itself — never fetched from the network, because a key served by whoever served the catalog only proves they agree with themselves.

There is no separate app registry, store database, or docs copy to keep in sync. The Suite Manager catalog, the landing page, and the [Apps section of these docs](/docs/apps/) are all generated from the same manifests. For the site that means a valid package folder is enough; to make an app *installable*, the package also needs an entry in the signed `apps/catalog.json`, regenerated with `npm run apps:catalog` and signed with `npm run apps:catalog:sign`.

## Installed snapshots

One rule defines the whole model:

> Installed behavior comes from the installed package snapshot. Source repositories provide candidates, never live runtime truth.

On install, MOS copies the validated package — manifest, setup schema, privacy review, Dockerfiles, runtime assets, and its recorded source identity — into a host-owned snapshot outside the moving repository checkout. Settings, projections, restart, health, integrations, backup, and uninstall all read that snapshot. Editing a repo manifest after install changes nothing on a running machine, and an installed app stays manageable even if the checkout is missing entirely.

## The manifest

`manifest.json` declares everything the platform needs to present, install, run, and connect the app:

- **Identity** — `id`, `name`, `version` (the *MOS package* version, not the upstream one), `summary`, `category`, `icon`, plus `minimumMosVersion` and optional `architectures` (Immich declares `["amd64"]`, so MOS refuses it on a host that isn't named rather than failing mid-build).
- **`catalog`** — presentation metadata: description, what the app `replaces`, feature list, setup-complexity and resource hints, privacy notes, tags, official links, related apps, and optional demo-deployment targets used only by the public site.
- **`setup`** — the install form, as data: typed fields (text/email/password) with labels, defaults, and required flags. Fields can be marked `generated` — MOS creates the secret itself and the user never sees a prompt.
- **`resources`** — the runtime shape: one or more services, each with its Dockerfile, internal port, environment (with `${secret.*}` / `${config.*}` / `${app.*}` interpolation), volumes, and dependencies. Multi-service apps (Seafile ships its own MySQL and Valkey) keep dependency containers internal-only.
- **`routes`** — the public hostname(s) Caddy should route, e.g. `seafile.<domain>`.
- **`homepage`** — the dashboard tile (group, name, description, icon), plus optional widgets.
- **`health`** — how the platform verifies the app is actually up.
- **`onboarding`** — optional post-install setup guides (steps, sections, copyable values) rendered in Suite Manager.
- **`exports` / `integrations`** — the capability system behind [app connections](/docs/guides/apps/): a provider exports a capability (ONLYOFFICE exports `documentEditor`), a consumer declares a slot for it (Seafile consumes one), and the platform can wire them together — secret grants, network attachment, config patching — without app-specific code in the core.

## Trust and sources

Every installed package records its source repository, path, immutable source revision, package digest, package version, minimum MOS version, and trust level. Packages from the signed official catalog are `mos-reviewed`. A Git source you add yourself is `unverified`, and stays labelled that way everywhere it appears. `publisher-signed` is reserved for a future publisher-key design and is refused today — a trust label with nothing standing behind it is worse than the honest one it would replace. Structural validity never promotes a package to reviewed.

Reviewed trust and the privacy posture are separate claims: the trust level records where a package came from, while a posture comes only from a valid `privacy-review.json` bound to the package's exact version, digest, and source revision. Every package in the official catalog ships one — assessment is a condition of catalog entry. The review travels into the snapshot, so you see the assessment for the package you're actually running — not the latest repository wording. It isn't a legal audit.

External packages reuse the same pipeline with a narrower profile. Publish a `.mos/` folder at the root of a GitHub repository, paste the repository URL into the Apps search, and MOS resolves the commit, extracts only `.mos/`, and runs a fail-closed gate before anything is built. Package ids are namespaced by source, so an external package cannot collide with or impersonate an official one. Privileged containers, host networking, the Docker socket, arbitrary host paths, raw Caddy directives, and other packages' secrets are refused outright.

## Updates

App packages version independently of the platform: a new app version needs no MOS release, and a platform update does not rebuild installed apps from newer repository files. Both directions are deliberate. MOS refreshes the signed catalog periodically, compares version and digest against what's installed, and shows the change before anything happens — versions, privacy movement, breaking changes, required owner actions, downtime, and rollback limits. Apply is transactional: the candidate builds from its own digest-verified snapshot before running containers are replaced, and health is checked before the new identity is committed.

Downgrades are blocked, so a force-pushed or taken-over source can't walk an app back to a version with published holes; an explicit recovery downgrade exists, bound to the exact installed/candidate digest pair. Be clear on the limit: a retained snapshot restores a build *definition*, never your data. Volumes are shared across versions, and a package that doesn't declare rollback safe is treated as `not-guaranteed`.

## Rules packages live by

- **No floating tags.** Base images in package Dockerfiles are pinned by immutable digest (`FROM image@sha256:…`); a bump is a deliberate package version, never a tag that resolves differently at build time.
- **Dockerfiles live at the package root** (`Dockerfile`, `Dockerfile.<service>`), and published paths are treated as stable API.
- **The README is the technical reference** — environment variables, volumes, health endpoints, project-specific patches. It's what renders under *Technical reference* on each [app docs page](/docs/apps/), so it is maintained next to the code it describes.

The full package contract — validation, snapshot and lifecycle semantics, capability wiring — is specified in [`apps/README.md`](https://github.com/rpuls/my-own-suite/blob/main/apps/README.md) in the repository. If you're thinking about packaging an app: that spec plus any existing package as a template is the way in.
