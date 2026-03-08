# Documentation Agent Instructions

This file defines how AI agents should write and maintain documentation in this repository.

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
3. **Maintain `CHANGELOG.md` during the work, not after.**
   - Add/update an entry under `## [Unreleased]` in the same branch as the change.
   - Keep entries concise and user-relevant.
4. **Release process must follow `RELEASING.md`.**
   - Do not invent ad-hoc versioning or release steps.
5. **No direct pushes to `main` and no direct commits on `main`.**
   - Use PR workflow only.
6. **When a change affects compatibility contracts, call it out explicitly in changelog.**
   - This includes env vars, compose service/profile names, Dockerfile paths, and persistent volume semantics.

## Pre-Work Checklist (Agents)

Before making edits, agents should confirm:

- Current branch is **not** `main`.
- If the change is intended for fast platform testing, target **`staging` first** rather than `main`.
- `CHANGELOG.md` contains or will contain an `Unreleased` entry for the change.
- Any needed docs split rules (MDX vs app README) are respected.
- Local git hooks are installed (`npm run hooks:install`) so commits/pushes on `main` are blocked.

## Goal

Use a strict split:
- End-user content lives in `site/src/content/docs/apps/*.mdx`
- Technical/operational content lives in `apps/*/README.md`

No duplicated content across these two sources.

## Single Source of Truth

- Technical specs must be authored in app README files only.
- App MDX pages must embed the matching README under a `References` section.
- If technical content appears in MDX body text, move it to README.
- If descriptive/end-user content appears in README, move it to MDX.

## Audience Split

### MDX (`site/src/content/docs/apps/*.mdx`) is for end users

Include:
- Short, plain-language app description immediately under title/logo.
- Core capabilities (what users can do).
- Optional roadmap/status notes if relevant.
- Links section (official website/repository/docs).
- Optional screenshots and explanatory narrative.

Do not include:
- Env var lists
- Volume mount details
- Healthcheck endpoints
- Container/runtime internals
- Deployment command runbooks
- Troubleshooting runbooks for operators
- Duplicated `References` title text
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
3. `### References`
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

### References

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
- No redundant titles like "`<App> References`" in embedded content.

## Editing Policy

- Preserve existing facts; do not drop meaningful technical details.
- Rephrase/move content rather than delete unless it is redundant filler.
- Keep wording concise and direct.

## Container and Versioning Rules

These rules are mandatory for app/service onboarding and version updates.

### Single source of truth for container versions

- Do not write runtime image tags/digests directly in `deploy/vps/docker-compose.yml`.
- `deploy/vps/docker-compose.yml` must use `build:` entries that point to Dockerfiles in `apps/`.
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

### Compose authoring rules when adding a service

When adding a new service to `deploy/vps/docker-compose.yml`:

- Use:
  - `build.context: ../../apps/<app>`
  - `build.dockerfile: Dockerfile` or `Dockerfile.<service>`
- Do not use direct `image:` references for services managed by this repo.

### VPS env template layout

- Runtime env templates live in:
  - `deploy/vps/.env.template`
  - `deploy/vps/services/<service>/.env.template`
- Do not reintroduce runtime env templates under `deploy/vps/apps/`.
- `deploy/vps/services/suite-manager/.env.template` is the shared control-plane input file for local/VPS setup.

### Docs and automation updates required with each new service

When adding/changing an app service, also update:

- `apps/<app>/README.md` technical specs (env vars, volumes, healthchecks, dependencies).
- `deploy/vps/services/<service>/.env.template` when relevant.
- `.github/dependabot.yml` Docker entries for the affected app root directory.
