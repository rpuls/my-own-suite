---
name: add-mos-app
description: Add a new application to the MOS manifest-driven package catalog, including package-owned Dockerfiles, runtime contract, persistence, setup, health, routes, backups, documentation, dependency updates, and mandatory privacy assessment. Use when onboarding or proposing any new MOS app or companion service.
---

# Add MOS App

Follow `AGENTS.md`, `apps/README.md`, and existing packages. Keep core runtime code generic and package-specific behavior inside `apps/<app>`.

## Workflow

1. Confirm role, user outcome, license, architecture support, resources, dependencies, and operational maturity.
2. Assign an app-package version independent of the MOS platform and upstream app versions. Declare the package source, minimum compatible MOS platform version, and trust level.
3. Pin every base image by immutable digest in root-level package Dockerfiles. Preserve public compatibility paths.
4. Design setup fields, secrets, services, volumes, routes, health checks, declared capabilities, integrations, onboarding, lifecycle behavior, and backup consistency requirements.
5. Follow the `assess-app-privacy` skill to create `privacy-review.json` and the manifest privacy posture. Never give an unreviewed app a favorable placeholder.
6. Ensure installation can preserve a self-contained package snapshot used for later settings, lifecycle, backup, and update comparisons.
7. Put technical facts in `apps/<app>/README.md`; keep end-user description and official links in the active site app page.
8. Add the app-root Dependabot Docker entry and focused generic contract tests. Do not hardcode the app id in core production code.
9. Update `CHANGELOG.md` and durable architecture/security decisions when applicable.
10. Run `npm run apps:catalog` after package changes, then `npm run apps:catalog:check`, focused package/privacy tests, `npm run typecheck`, and the relevant build. Ask the user to run applicable E2E commands. Regenerating the catalog invalidates its committed Ed25519 signature; the signature half of `apps:catalog:check` fails until the key holder runs `MOS_CATALOG_SIGNING_KEY=<key path> npm run apps:catalog:sign`. Without the key, treat that failure as expected and report re-signing as a required pre-merge step — never edit `.sig` files by hand.

Stop and report unresolved license, privacy, persistence, migration, backup, architecture, or upstream-image questions rather than representing the package as supported.
