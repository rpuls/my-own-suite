# Releasing My Own Suite

This document defines the official release workflow for this repository.

## Goals

- Keep releases predictable and safe.
- Keep rapid prototyping separate from stable releases.
- Preserve cross-platform compatibility contracts already present in this repo.
- Make upgrades easy for users and maintainers.

## Branch Model

- `feat/*`, `fix/*`, `docs/*`, `chore/*`: short-lived working branches.
- `staging`: integration branch for fast testing on deployment platforms and bundled feature validation.
- `main`: stable, release-grade branch used for published releases and production-ready templates.

Default flow:

1. Build the change on a short-lived branch.
2. Merge it into `staging` for integration testing.
3. Batch validated `staging` changes into a release branch.
4. Merge the release branch into `main`.

## Versioning

This project uses **Semantic Versioning**: `MAJOR.MINOR.PATCH`.

- `PATCH` (`x.y.Z`): bug fixes, docs fixes, non-breaking maintenance.
- `MINOR` (`x.Y.z`): new features/services that are backward compatible.
- `MAJOR` (`X.y.z`): breaking changes requiring user action.

## Compatibility Contracts (Breaking if changed)

Treat these as stable API unless intentionally released as a major version:

- Dockerfile paths used by deploy templates (`apps/<app>/Dockerfile`, `apps/<app>/Dockerfile.<service>`).
- App package service names and generated runtime projections.
- Package manifest setup fields and env var contracts.
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
- An updated root `VERSION` file containing `X.Y.Z`
- An updated root `releases/stable.json` manifest containing the stable channel metadata

These files must agree with each other and with the release tag.

The MOS1 layout also shipped an `apps/suite-manager/release.json` so packaged installs could report their version without the repo root. The MOS root layout reports the installed version from the root `VERSION` file, which stable release-track managed updates also use for installed-versus-latest comparison. Add a packaged metadata file back (and extend `scripts/release-check.cjs`) only if a Suite Manager distribution without the repo root returns.

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

1. Ensure `staging` is green (CI passing) and contains the batch you want to release.
2. Create release branch from `staging`:
   - `release/vX.Y.Z`
3. Update `CHANGELOG.md`:
   - Sections: `Added`, `Changed`, `Fixed`, `Breaking` (if any).
4. Update release metadata files so they all match the intended version:
   - `VERSION`
   - `releases/stable.json`
5. Validate locally (at minimum):
   - `npm run release:check`
   - `npm test`
   - `npm run typecheck`
   - `npm run build:client`
   - `npm run build` (public site)
6. Merge release branch into `main`.
7. Merge or fast-forward `main` back into `staging` if needed to keep branches aligned after release-only edits.
8. Create and push tag:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`
9. Publish GitHub Release from tag `vX.Y.Z` with:
   - summary
   - upgrade steps
   - breaking changes (if any)
   - rollback notes (if relevant)

## Release Prep Details

When editing the versioned metadata files:

- `VERSION` should contain only `X.Y.Z`
- `releases/stable.json` should describe the newest stable release users should compare against

Recommended release prep order:

1. Pick `X.Y.Z` using the SemVer rules above.
2. Update `CHANGELOG.md` for that release.
3. Update `VERSION`.
4. Update `releases/stable.json`.
5. Build and sanity-check Suite Manager (`npm run build:client`) before tagging.
6. Run `npm run release:check` from the repo root and fix any metadata drift before tagging.

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
- [ ] `VERSION` updated
- [ ] `releases/stable.json` updated
- [ ] `npm run release:check` passed
- [ ] CI passing on release branch
- [ ] Honesty pages re-verified: rating-coverage wording, video links, and site screenshots still match the current product and UI
- [ ] Upgrade notes written
- [ ] Breaking changes documented (if any)
- [ ] Tag pushed: `vX.Y.Z`
- [ ] GitHub Release published

## Recommended First Release

If this is the first formal public release, start with:

- `v0.1.0` (initial usable release)

When compatibility commitments harden and upgrade paths are stable, move to:

- `v1.0.0`
