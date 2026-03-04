# Releasing My Own Suite

This document defines the official release workflow for this repository.

## Goals

- Keep releases predictable and safe.
- Preserve cross-platform compatibility contracts already present in this repo.
- Make upgrades easy for users and maintainers.

## Versioning

This project uses **Semantic Versioning**: `MAJOR.MINOR.PATCH`.

- `PATCH` (`x.y.Z`): bug fixes, docs fixes, non-breaking maintenance.
- `MINOR` (`x.Y.z`): new features/services that are backward compatible.
- `MAJOR` (`X.y.z`): breaking changes requiring user action.

## Compatibility Contracts (Breaking if changed)

Treat these as stable API unless intentionally released as a major version:

- Dockerfile paths used by deploy templates.
- Docker Compose profile names and service names.
- Env var names in `deploy/vps/apps/*/.env.example`.
- Persistent volume semantics/locations.
- App URL patterns/subdomain expectations.

If any of the above must change:

1. Add migration notes in `CHANGELOG.md`.
2. Add upgrade instructions in the GitHub Release notes.
3. Bump `MAJOR` version.

## Release Artifacts

Each release includes:

- A git tag: `vX.Y.Z`
- A GitHub Release using the same tag
- An updated `CHANGELOG.md`

Optional but recommended:

- `VERSION` file containing `X.Y.Z`

## Safety Guardrails (Recommended)

Install local git hooks once per clone:

```bash
npm run hooks:install
```

These hooks block committing/pushing directly on `main` and reinforce PR-only workflow.

## PR Labeling Rules

Use at least one of:

- `breaking`
- `feature`
- `fix`
- `docs`
- `chore`

Version bump guidance:

- Any `breaking` PR in release scope -> `MAJOR`
- Else if any `feature` PR -> `MINOR`
- Else -> `PATCH`

## Standard Release Workflow

1. Ensure `main` is green (CI passing).
2. Create release branch from `main`:
   - `release/vX.Y.Z`
3. Update `CHANGELOG.md`:
   - Sections: `Added`, `Changed`, `Fixed`, `Breaking` (if any).
4. Validate locally (at minimum):
   - docs build
   - compose config validation
   - shell script lint parity with CI expectations
5. Merge release branch into `main`.
6. Create and push tag:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`
7. Publish GitHub Release from tag `vX.Y.Z` with:
   - summary
   - upgrade steps
   - breaking changes (if any)
   - rollback notes (if relevant)

## Hotfix Workflow

Use for urgent production-impacting issues.

1. Branch from released tag `vX.Y.Z`:
   - `hotfix/vX.Y.(Z+1)`
2. Apply minimal fix.
3. Update changelog with hotfix entry.
4. Tag and release `vX.Y.(Z+1)`.
5. Merge hotfix back into `main`.

## Release Checklist (Copy/Paste)

- [ ] Version selected using SemVer rules
- [ ] Changelog updated
- [ ] CI passing on release branch
- [ ] Upgrade notes written
- [ ] Breaking changes documented (if any)
- [ ] Tag pushed: `vX.Y.Z`
- [ ] GitHub Release published

## Recommended First Release

If this is the first formal public release, start with:

- `v0.1.0` (initial usable release)

When compatibility commitments harden and upgrade paths are stable, move to:

- `v1.0.0`
