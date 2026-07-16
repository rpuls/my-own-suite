---
name: update-mos-app
description: Update an existing MOS app or companion service safely by reviewing upstream releases and breaking changes, refreshing digest-pinned Dockerfiles and package contracts, reassessing privacy and legal-policy changes, documenting compatibility, and validating migrations and rollback. Use for version, image, dependency, manifest, or upstream policy updates to packaged apps.
---

# Update MOS App

Read `AGENTS.md`, the latest source package, its privacy assessment, every upstream release crossed, and existing compatibility contracts before editing. The package version is independent of MOS platform and upstream versions.

## Breaking-change gate

Do not rely on semver or an upstream "breaking" label. Check:

- removed, renamed, required, or behavior-changing environment variables and defaults;
- database, index, file-format, volume, ownership, permission, and migration changes;
- required intermediate versions, irreversible migrations, downgrade and rollback limits;
- APIs, routes, ports, health endpoints, authentication, sessions, clients, and integrations;
- service topology, architecture support, CPU/RAM/disk requirements, and startup behavior;
- image entrypoints, users, filesystems, base distributions, and Dockerfile contracts;
- backup consistency, restore compatibility, and large-data implications;
- licenses, Terms, privacy policies, telemetry, outbound endpoints, accounts, and acquisitions;
- removed features, changed defaults, manual actions, and deprecations.

Classify each relevant change as automatically handled, migration required, operator action required, unsupported, or unresolved. Block the update when no safe, truthful path exists.

## Workflow

1. Establish the previous and candidate app-package versions, exact upstream versions/digests, and all intervening upstream releases.
2. Complete the breaking-change gate and plan migrations before changing pins.
3. Use `$assess-app-privacy` for the target version even if policy URLs look unchanged.
4. Update Dockerfiles, manifests, runtime wiring, README, Dependabot, and tests together; bump the package version according to the package-level compatibility impact.
5. Preserve public Dockerfile paths and volume semantics; call compatibility changes out in `CHANGELOG.md`.
6. Verify that installed instances can compare their preserved installed snapshot with this candidate without replacing installed settings or privacy information before apply.
7. Test fresh install and supported upgrade paths, including health, integrations, backup assumptions, and failures.
8. Run `npm run apps:catalog` after package changes, then `npm run apps:catalog:check`, privacy/manifest tests, `npm run typecheck`, and the relevant build. Ask the user to run relevant E2E or hardware validation. Regenerating the catalog invalidates its committed Ed25519 signature; the signature half of `apps:catalog:check` fails until the key holder runs `MOS_CATALOG_SIGNING_KEY=<key path> npm run apps:catalog:sign`. Without the key, treat that failure as expected and report re-signing as a required pre-merge step — never edit `.sig` files by hand.

Never refresh a digest without identifying the resolved version and reviewing the releases it crosses.
