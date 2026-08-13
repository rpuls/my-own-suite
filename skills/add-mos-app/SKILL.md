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
8. Build the catalog presentation — description, features, and screenshots. See **Catalog presentation** below; it is not optional polish.
9. Add the app-root Dependabot Docker entry and focused generic contract tests. Do not hardcode the app id in core production code.
10. Update `CHANGELOG.md` and durable architecture/security decisions when applicable.
11. Run `npm run apps:manifest:check` and `npm run apps:catalog` after package changes, then `npm run apps:catalog:check`, focused package/privacy tests, `npm run typecheck`, and the relevant build. Ask the user to run applicable E2E commands. Regenerating the catalog invalidates its committed Ed25519 signature; the signature half of `apps:catalog:check` fails until the key holder runs `npm run apps:catalog:sign` (prompts to paste the key). Without the key, treat that failure as expected and report re-signing as a required pre-merge step — never edit `.sig` files by hand.

## Catalog presentation

Most people meet an app through its catalog card and screen gallery, and decide there whether it is worth an install. A correct package with a thin presentation is an unfinished package.

Aim for a gallery a person recognises themselves in: real-looking money, real-looking documents, a real-looking week. Each shot should show one distinct capability, and the sequence should read as a story rather than a feature list.

### Words

- The summary says what the app does for a person in one sentence, in their language, not the project's. Name the thing it replaces if that lands faster than describing it.
- Features are outcomes ("see what is left to spend this month"), not components ("envelope engine").
- `replaces` is a ranked list, not a label. Name every commercial product the app honestly stands in for — usually six to ten — ordered by how likely a person is to recognise the name, because the first two are all a card can show and the app's docs page turns the rest into the page someone finds when they search "&lt;product&gt; alternative". Only list products the app actually does the job of; a padded list is obvious and cheapens the ones that are true.
- Keep the end-user description in the manifest and the technical facts in `apps/<app>/README.md`. Do not write the same sentence twice.

### Screenshots

**Look for a built-in demo before building anything.** Several apps ship one with usable seed data — Actual Budget has a demo budget, and starting from it would have saved a day of writing a seeding script. Check the app's first-run screens and docs first. Fall back to seeding only when there is no demo, or when its data is unusable (wrong language, wrong currency, obviously fake).

**Capture your own; never reuse upstream's.** Upstream projects are usually copyleft, so their images carry a licence notice and attribution, and their demo data will not match the house style. Software running locally on invented data is our own copyright with nothing to attribute; the app's own logo in the UI chrome is nominative trademark use.

**Invent the data, and reuse one fictional household across apps.** Fictional companies, fictional people, `.example` domains, invented account numbers. Never a real brand, a real person, or the owner's own name. Paperless-ngx established Mr J. Fletcher of 47 Canal Street, Northbrook, renting from Harbourside Housing and working at Falk Engineering; Actual Budget reuses them, so the two galleries are one household's paperwork and one household's money. Content is English — the site is English, and a reader cannot relate to a screenshot they cannot read.

**Shoot for the frame the gallery actually uses.** `.app-gallery-frame` in `site/src/styles/landing.css` is `aspect-ratio: 16 / 10`, so a 16:9 capture letterboxes. The gallery renders the image at roughly 990 CSS px, so a wide capture is scaled down and the text becomes unreadable — 1440 CSS px lands at about 0.6×. Find the app's own wide-layout breakpoint and sit just above it, then raise `deviceScaleFactor` for sharpness rather than raising the viewport. Actual Budget ships 1147×717 at `deviceScaleFactor` 2.2319 → 2560×1600.

**Check the result in the real gallery, not the PNG.** Build the site, open the app drawer, and read the screenshots at the size a visitor sees. A capture that looks fine at full size can be illegible in the frame.

**Park the mouse off-grid before every shot** or a hover-reveal control bakes in and reads as a glitch.

**Log every off-site request the capture makes**, and print the host list at the end of the run. A capture session drives the app the way an owner would, which makes it the cheapest network observation you will ever get — and it has caught calls the package's own privacy review missed. Anything unexpected in that list is a finding to report, not noise to filter out.

**Reuse an existing rig's corpus before inventing another one.** The household is meant to be shared, and adapting is usually a few lines: the Stirling PDF rig imports the Paperless-ngx document definitions and prints them to PDF instead of rasterising them, so the two galleries are the same paperwork.

**Keep the rig** at `.local-tools/screenshot-rigs/<app>/` (git-ignored, so it never ships): compose file building the real package Dockerfiles, seed or demo-setup script, capture script, and a one-command runner. Write a README next to it recording what fought back — forced first-run dialogs, a client that refuses plain HTTP, state that lives in the browser rather than the server. On a version bump, update the digests and replay it instead of rebuilding the setup from memory.

**Wire it up.** Relative `catalog.screenshots[].src` values must also be listed in `packageFiles`, or the backend will not serve them.

Stop and report unresolved license, privacy, persistence, migration, backup, architecture, or upstream-image questions rather than representing the package as supported.
