# Repository Agent Instructions

This file defines how AI agents should work in this repository, with special rules for documentation, app onboarding, and platform validation.

It is the single tool-agnostic source of truth for agent rules: Codex, Claude Code (via the `CLAUDE.md` pointer), and other coding agents all follow this file. Do not create tool-specific rule folders (`.codex/`, `.agents/`, `.clinerules/`, etc.); put durable rules here and durable working context in [docs/codex-notes.md](./docs/codex-notes.md).

## Mandatory Workflow (All Agent Tasks)

These rules are required for every non-trivial change (docs, config, code, infra).

1. **Never work directly on `main`.**
   - If current branch is `main`, create and switch to a new branch before editing.
   - Branch name format:
     - `docs/<topic>`
     - `fix/<topic>`
     - `feat/<topic>`
     - `chore/<topic>`
2. **Use `staging` as the default integration target for feature work.**
   - Merge feature branches into `staging` first when the goal is fast template/infrastructure testing.
   - Promote tested batches from `staging` to `main` through the release workflow in `RELEASING.md`.
3. **Maintain `CHANGELOG.md` during releasable software work, not after.**
   - Add/update an entry under `## [Unreleased]` in the same branch when the change affects Suite Manager or installed-platform behavior, operations, compatibility, or another outcome relevant to people updating MOS.
   - Do not add changelog entries for documentation-only, public-site-only, landing-page-only, repository-maintenance, or contributor-workflow changes. Those are not updater-facing software behavior.
   - If documentation or public-site copy accompanies a software behavior change, describe the behavior once; do not separately log the documentation or site edit.
   - Keep entries concise, user-relevant, and release-shaped.
   - Prefer a few broad release-note bullets over a detailed work log of small implementation changes.
   - Do not add a new changelog bullet for every follow-up fix, test tweak, or implementation step within the same area of work.
   - Fold iterative work into an existing broader bullet unless the later change introduces a distinct user-visible outcome, operational change, or compatibility note.
   - Avoid logging low-level refactors, internal cleanups, or development-only harness work on their own unless they change user-visible behavior, operations, or compatibility.
   - When in doubt, compress multiple related tweaks into one broader bullet instead of listing them separately.
4. **Release process must follow `RELEASING.md`.**
   - Do not invent ad-hoc versioning or release steps.
- Keep all release metadata files aligned when preparing a release:
     - root `VERSION`
     - root `releases/stable.json`
     - any Suite Manager release metadata file that exists in the active root layout
   - Run `npm run release:check` whenever a task changes release metadata or prepares a release branch.
5. **No direct pushes to `main` and no direct commits on `main`.**
   - Use PR workflow only.
6. **When a change affects compatibility contracts, call it out explicitly in changelog.**
   - This includes env vars, compose service/profile names, Dockerfile paths, and persistent volume semantics.
7. **Managed platform updates must fully apply all platform-owned code.**
   - A managed update must not leave Suite Manager, host agents, generated env/compose wiring, or systemd units running old code after reporting success.
   - If repo-owned host agents need new capabilities, update/restart them as part of the same managed update instead of adding UI around the partially applied state.
   - Treat a partially applied managed update as a regression to fix at the update mechanism level.
   - Installed app runtimes are intentionally outside a platform update's scope: each app runs from the package snapshot it was installed with, and app changes apply only through the per-app update transaction. A platform update must not silently rebuild installed apps, and must not claim to have updated them.

## Pre-Work Checklist (Agents)

Before making edits, agents should confirm:

- Current branch is **not** `main`.
- If the change is intended for fast platform testing, target **`staging` first** rather than `main`.
- If the work changes updater-facing software behavior, `CHANGELOG.md` contains or will contain an `Unreleased` entry; docs-only and public-site-only work does not require one.
- Any needed docs split rules (MDX vs app README) are respected.
- Local git hooks are installed (`npm run hooks:install`) so commits/pushes on `main` are blocked.
- If the work is release-related, confirm `VERSION`, `releases/stable.json`, and any Suite Manager release metadata will stay in sync with the intended tag.

## Documentation Ownership Workflow

Documentation must have a single source of truth. Before adding or moving Markdown files, check [docs/README.md](./docs/README.md) and update the existing owner instead of creating a competing document.

Use these locations:

- Root `README.md`: repository landing page and documentation map.
- Root `CHANGELOG.md`: updater-facing software release notes only, excluding documentation, public-site, landing-page, repository-maintenance, and contributor-workflow-only changes.
- Root `RELEASING.md`: official release workflow only.
- Root `AGENTS.md`: agent workflow and repository rules only.
- `docs/README.md`: documentation ownership map.
- `docs/decisions.md`: durable architecture decisions and their consequences.
- `docs/codex-notes.md`: durable Codex/project working context.
- `.github/ISSUE_TEMPLATE/codex-task.yml`: task template source of truth.
- `site/`: MOS public/end-user documentation source; the deployed public site. GitHub Actions builds it and deploys to Cloudflare Pages from `main` and `staging` only (`.github/workflows/deploy-site.yml`).
- `site-mos1-reference/`: preserved MOS1 public site source; no longer built or deployed. Frozen content only; no new product docs.
- `apps/<app>/README.md`: app-level technical reference.
- `scripts/README.md`: MOS operator/developer script and smoke-harness guidance.
- `infrastructure/`: shared MOS runtime and installer substrate.
- `system-agents/`: MOS host-agent implementation.

Maintenance rules:

- Do not create new long-lived roadmap, TODO, decision, or planning Markdown files unless no current owner fits.
- Use GitHub Issues for task state and roadmap-like planning; do not maintain long-lived task lists in repo docs.
- If a task changes long-term direction, capture actionable follow-up in GitHub Issues and update `docs/decisions.md` only when the direction changes architecture, deployment contracts, security boundaries, or ownership model.
- If a task changes architecture, deployment contracts, security boundaries, or ownership model, update `docs/decisions.md`.
- If a task changes how agents or contributors should work, update `AGENTS.md` or `docs/codex-notes.md`, depending on whether it is a hard rule or contextual note.
- If a temporary feature plan is useful during a branch, remove it or replace it with a pointer before merging.
- Keep runbooks close to the thing they operate unless they become broad project policy.
- Do not move `README.md`, `CHANGELOG.md`, `RELEASING.md`, or `AGENTS.md` into `docs/`; these are intentionally root-level convention files.

## Branding Workflow

Branding in this repo uses a single-source-of-truth workflow. Agents must follow it whenever touching shared visual identity.

- Canonical project branding lives under `branding/`.
- `branding/styles/mos.css` is the canonical shared MOS brand stylesheet.
- Canonical logo and favicon assets live in `branding/` and `branding/favicons/`.
- Do not create or maintain hand-edited duplicate brand styles inside `site/`, `suite-manager/`, or other app folders when the change is meant to affect shared MOS branding.
- App-local branding copies that exist for runtime isolation are generated artifacts or sync targets, not the source of truth.
- When changing shared branding, run `npm run branding:sync`.
- If a task changes shared branding inputs, verify the affected app-local outputs were refreshed before finalizing.
- If an app needs a one-off local style that is not part of shared MOS branding, keep it narrowly scoped and do not move shared tokens out of `branding/styles/mos.css`.

Current shared-branding sync targets include:

- `site/generated/branding/mos.css`
- `suite-manager/frontend/src/styles/mos.css`
- `infrastructure/homepage/custom.css` for the synced Homepage theme block
- public brand/favicons copied into app-local runtime folders

## Suite Manager UI Component Workflow

Suite Manager UI must stay cohesive and predictable. Agents must treat shared UI primitives as part of the design framework, not as optional convenience helpers.

- Reuse existing shared components before creating new local controls. Current shared primitives live in `suite-manager/frontend/src/components/` and include dialog frames, notices/alerts, text inputs, text areas, and selects.
- Do not create one-off or near-duplicate dialogs, dropdowns, alert banners, text inputs, expand/collapse controls, or choice cards with slightly different styling or behavior.
- If a new interaction pattern is needed, first extend the shared component API or add a new shared primitive, then migrate the feature to use it.
- Keep component behavior consistent across Suite Manager: labels, helper text, disabled states, focus states, icon placement, spacing, responsive layout, and error/success/info styling should come from the shared component layer and shared CSS.
- Feature-specific components may compose shared primitives, but should not redefine their core look, spacing, or behavior locally.
- Avoid unnecessary card nesting in Suite Manager. Keep a readable outer page surface, then use dividers, grouped rows, or a small number of clear panels instead of stacking cards inside cards inside cards.
- Use **Advanced details** for low-level technical information that is useful for support or debugging but intimidating for normal users. Preserve the details, but keep raw logs, generated config, command output, IDs, paths, and similar diagnostics behind a collapsed disclosure or dialog while the primary UI explains the user-facing state in plain language.
- When touching forms or dialogs, check nearby Suite Manager screens for existing component patterns and update the shared primitive if the pattern should improve everywhere.

## Goal

Use a strict split after the MOS public docs rebuild:
- End-user content lives in the active `site/` docs source
- Technical/operational content lives in `apps/*/README.md`

No duplicated content across these two sources.

## Single Source of Truth

- Technical specs must be authored in app README files only.
- App MDX pages must embed the matching README under a `Technical reference` section.
- If technical content appears in MDX body text, move it to README.
- If descriptive/end-user content appears in README, move it to MDX.

## Audience Split

### Public Site Docs Are For End Users

Include:
- Short, plain-language app description immediately under title/logo.
- Core capabilities (what users can do).
- Optional status notes if relevant.
- Links section (official website/repository/docs).
- Optional screenshots and explanatory narrative.

Do not include:
- Env var lists
- Volume mount details
- Healthcheck endpoints
- Container/runtime internals
- Deployment command runbooks
- Troubleshooting runbooks for operators
- Duplicated `Technical reference` title text
- Low-value filler sections (e.g. weak "Other relevant info")

### README (`apps/*/README.md`) is for maintainers/developers

Include only technical content that is operationally useful:
- Environment variables
- Volumes/persistence
- Healthcheck endpoint(s)
- Dependencies/integrations (technical only)
- Project-specific customizations/patching behavior
- Operational commands (only if real and useful)
- Troubleshooting (only if real and useful)

Do not include:
- Marketing copy
- End-user capabilities lists
- App description prose already present in MDX
- Official links (links belong in MDX)
- Empty/no-op sections that only say "not documented"

## Required MDX Pattern (Apps)

Use this structure:

1. Frontmatter + app logo marker div
2. Description text (no `Application description` heading)
3. `## Technical reference`
4. Embedded README content via import/render
5. `## Links`

Example:

```mdx
---
title: Example App
description: Short user-facing summary.
slug: docs/apps/example
---

import * as TechSpecs from '../../../../../apps/example/README.md';

<div className="app-page app-example" aria-hidden="true"></div>

Example app helps users do X and Y in plain language.

## Technical reference

<div className="tech-specs">
  <TechSpecs.Content />
</div>

## Links

- [Example website](https://example.com/)
```

## Heading and Noise Rules

- Avoid redundant headings:
  - Do not use `Application description`
  - Do not add `Other relevant info` unless it is genuinely useful and non-redundant
- If an `Other relevant info` section is empty or weak, remove it.
- Keep docs easy to scan; prefer fewer sections over filler.

## Quality Checklist (Before Finalizing)

For each app page:
- MDX contains only end-user content + links + embedded references.
- README contains only technical/maintenance content.
- No duplicated sentence appears in both MDX and README unless absolutely necessary.
- No empty sections.
- No redundant titles like "`<App> Technical reference`" in embedded content.

## Editing Policy

- Preserve existing facts; do not drop meaningful technical details.
- Rephrase/move content rather than delete unless it is redundant filler.
- Keep wording concise and direct.

## E2E Testing Workflow

The repo includes real black-box Playwright tests for MOS flows without test-only application bypasses.

- Do not run E2E tests automatically as an agent. Ask the user to run the relevant E2E command and paste only the relevant failure output, because full Playwright/Docker logs are noisy and quickly pollute the context window.
- Do not run `npm run smoke:do:reset` automatically as an agent. It creates or replaces a paid smoke Droplet, destructively removes MOS containers, Docker volumes, and the remote checkout before reinstalling, and produces noisy logs. Ask the user to run it and paste only the relevant failure output or final readiness summary.
- `npm run smoke:do:destroy` may be run by an agent only when explicitly asked or confirmed by the user, because it is a paid-resource cleanup command.
- Prefer end-to-end validation for onboarding and app reachability changes before adding unit-test-only coverage.
- Keep E2E tooling isolated under `test/e2e` unless a shared repo-level script or config is genuinely needed.
- Do not add source-code-only test hooks, fake auth shortcuts, or alternate code paths just to make tests easier.
- When changing onboarding, auth, Homepage routing, or app integration behavior, consider whether `npm run e2e:full` should be rerun before finalizing.

Useful commands:

- `npm run e2e:install` installs Playwright browser dependencies.
- `npm run e2e:local` runs the local MOS browser suite.
- `npm run e2e:local:headed` runs the local MOS browser suite in a visible browser.
- `npm run e2e:full` runs the Hyper-V full-platform suite against an already-running VM.
- `npm run e2e:full:headed` runs the Hyper-V suite in a visible browser.

## Container and Versioning Rules

These rules are mandatory for app/service onboarding and version updates.

### Single source of truth for container versions

- Do not write runtime image tags/digests directly into generated runtime projections.
- MOS app package services must use package-owned Dockerfiles in `apps/`.
- Pin base images in Dockerfiles with immutable digests (`FROM image@sha256:...`).
- Never use floating tags like `latest` or `release` in runtime Dockerfiles.

### Required Dockerfile layout

For each app, Dockerfiles must live in the app root folder:

- Primary app service: `apps/<app>/Dockerfile`
- Additional services: `apps/<app>/Dockerfile.<service>`

Examples:

- `apps/immich/Dockerfile`
- `apps/immich/Dockerfile.machine-learning`
- `apps/immich/Dockerfile.postgres`
- `apps/immich/Dockerfile.valkey`
- `apps/seafile/Dockerfile`
- `apps/seafile/Dockerfile.mysql`
- `apps/seafile/Dockerfile.memcached`

Do not introduce new canonical Dockerfiles in nested subfolders like `apps/<app>/<service>/Dockerfile`.

### Backward compatibility for existing paths

- Dockerfile paths used by external deploy templates (Railway/Dokploy) are treated as stable API.
- If a path is already used publicly, do not remove or move it in a patch/minor change.
- If a path migration is needed:
  - Keep the old Dockerfile as a compatibility stub.
  - Add a deprecation comment pointing to the canonical root-level Dockerfile.
  - Remove old paths only in a clearly documented breaking release.

### App Manifest Runtime Rules

When adding or changing a package service, update the package manifest and keep generated runtime projections rooted at `apps/<app>`.

### Catalog Privacy-Review Requirement

- No app enters the official catalog without a completed privacy posture review.
- A new `apps/<app>/` package must ship a valid `privacy-review.json`, bound to the exact package version and digest, before it gets an entry in the signed `apps/catalog.json`.
- Because of this rule, site and docs copy may claim that every catalog app carries a published assessment. Keep that claim unconditional; never hardcode an app count that goes stale.

### Docs and automation updates required with each new service

When adding/changing an app service, also update:

- `apps/<app>/README.md` technical specs (env vars, volumes, healthchecks, dependencies).
- package manifest setup fields, resources, routes, and capabilities when relevant.
- `.github/dependabot.yml` Docker entries for the affected app root directory.
