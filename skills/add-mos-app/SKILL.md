---
name: add-mos-app
description: Add a new application to the MOS manifest-driven package catalog, including package-owned Dockerfiles, runtime contract, persistence, setup, health, routes, backups, documentation, dependency updates, and mandatory privacy assessment. Use when onboarding or proposing any new MOS app or companion service.
---

# Add MOS App

Follow `AGENTS.md`, `apps/README.md`, and existing packages. Keep core runtime code generic and package-specific behavior inside `apps/<app>`.

The manifest is a locked, versioned contract: author against manifest generation 1 (`manifestVersion: 1`) as specified by `apps/manifest.schema.json` and the reference page `site/src/content/docs/docs/reference/manifest.md`. Validate early and often with `npm run apps:manifest:check -- apps/<app>`. Treat fields the reference marks provisional (capability system, `homepage.widget`, `internalIcalBridge`) as changeable, and never add new manifest fields for one app — if the contract cannot express the package, stop and report it as a platform finding per the amendment policy in `AGENTS.md`.

## Workflow

1. Confirm role, user outcome, license, architecture support, resources, dependencies, and operational maturity.
2. Assign an app-package version independent of the MOS platform and upstream app versions. Declare the package source, minimum compatible MOS platform version, and trust level. Set `minimumMosVersion` to at least the first release carrying the locked manifest validator (0.17.0) and higher if the package uses newer contract fields.
3. Pin every base image by immutable digest in root-level package Dockerfiles. Preserve public compatibility paths.
4. Design setup fields, secrets, services, named volumes, routes, health checks, declared capabilities, integrations, onboarding, lifecycle behavior, and backup consistency requirements within the locked manifest shape — no host paths, extra ports, or raw proxy configuration.
5. Follow the `assess-app-privacy` skill to create `privacy-review.json` and the manifest privacy posture. Never give an unreviewed app a favorable placeholder.
6. Ensure installation can preserve a self-contained package snapshot used for later settings, lifecycle, backup, and update comparisons.
7. Put technical facts in `apps/<app>/README.md`; keep end-user description and official links in the active site app page.
8. Add the app-root Dependabot Docker entry and focused generic contract tests. Do not hardcode the app id in core production code.
9. Update `CHANGELOG.md` and durable architecture/security decisions when applicable.
10. Run `npm run apps:manifest:check` and `npm run apps:catalog` after package changes, then `npm run apps:catalog:check`, focused package/privacy tests, `npm run typecheck`, and the relevant build. Ask the user to run applicable E2E commands. Regenerating the catalog invalidates its committed Ed25519 signature; the signature half of `apps:catalog:check` fails until the key holder runs `npm run apps:catalog:sign` (prompts to paste the key). Without the key, treat that failure as expected and report re-signing as a required pre-merge step — never edit `.sig` files by hand.

Stop and report unresolved license, privacy, persistence, migration, backup, architecture, or upstream-image questions rather than representing the package as supported.
