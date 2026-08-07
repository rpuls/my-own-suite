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

GitHub enforces the same thing on its side, so a fresh clone without hooks is still safe:

- `main` is protected — pull request required, CI must pass, no force pushes, no deletion.
  Admins are not enforced, so there is a deliberate manual override for emergencies.
- The repository allows **merge commits only**. Squash and rebase merging are disabled,
  because a squashed release PR would rewrite the commit the tag is supposed to point at.

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

Two commands and a tag. Everything that can be checked is checked by one gate, and
everything that can be automated happens when the tag is pushed.

1. Ensure `staging` is green (CI passing) and contains the batch you want to release.
2. Create release branch from `staging`: `release/vX.Y.Z`
3. Prepare the release:

   ```bash
   npm run release:prepare -- X.Y.Z
   ```

   This rewrites `VERSION` and `releases/stable.json`, moves everything under
   `## [Unreleased]` into a dated `## [X.Y.Z]` section, and then runs the release gate
   against what it just wrote. It refuses to leave a prepared-but-invalid tree behind.
   It does not commit, so review the diff.
4. Commit the prepared files, open the PR into `main`, and merge it with a **merge commit**.
5. Optional, and worth it when the installer or the pipeline itself changed: go to
   **Actions → Release → Run workflow** on `main`. That runs the same gate and the same
   installer build, uploads to `dry-run/` in the bucket, and stops before publishing. It
   rehearses the part of a release a moved tag cannot undo.
6. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Pushing the tag runs `.github/workflows/release.yml`, which:

- refuses to go further if the tagged commit is not on `main`, so a tag cannot publish
  code that never went through a pull request;
- re-runs `npm test` and `npm run release:check -- --release vX.Y.Z`, so a hand-made tag
  cannot skip a check the prepare step would have caught;
- renders the installer seed **pinned to the tag**, and fails if it resolves to a branch
  or carries a build-time password;
- builds the installer ISO, checksums it, and uploads it to R2;
- publishes the GitHub Release with the download link, the SHA256, and the changelog
  section for that version.

Any failing step means no release is published. Fix forward and move the tag.

### The release gate

`npm run release:check` runs in two modes:

- **No arguments** — part of `npm test` on every branch. Checks only that the release
  metadata agrees with itself, so ordinary work is never blocked by a changelog section
  nobody has written yet.
- **`--release vX.Y.Z`** — the gate a published release must pass. Every warning becomes a
  failure, and it additionally checks that the tag matches `VERSION`, that
  `releases/stable.json` points at the right notes URL and carries a valid timestamp, and
  that nothing is stranded under `## [Unreleased]`.

Both `release:prepare` and the pipeline run the second form. That is deliberate: there is
one definition of "ready to release" and no way for local and CI to disagree about it.

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

## One-time infrastructure setup

Needed once, ever, before the first automated release. Not per release.

1. Create an R2 bucket named `mos-downloads` in the Cloudflare account that already
   serves the site.
2. Bind the custom domain `downloads.myownsuite.org` to that bucket, and confirm the DNS
   record resolves. The release notes link to this hostname, so it has to exist before
   the first tag.
3. In **R2 → Manage API Tokens**, create an Object Read & Write token scoped to that
   bucket, then add both halves as repository secrets:
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`

   These are R2's S3 credentials, which are not the same thing as `CLOUDFLARE_API_TOKEN`.
   The workflow uses the S3 API because the image is several gigabytes and needs multipart
   upload; `wrangler r2 object put` sends a single request and would fail on a file this size.
4. `CLOUDFLARE_ACCOUNT_ID` is already a repository secret from the site deployment and is
   reused to build the R2 endpoint. Nothing to do.

Consider an R2 lifecycle rule that expires objects older than a few releases. Release notes
for superseded versions can then be edited to point at the current download.

## Release Checklist (Copy/Paste)

Most of this is now enforced rather than remembered — the gate fails if it is not true. What
remains is the judgement a script cannot make.

- [ ] Version selected using SemVer rules
- [ ] Changelog entries are release-shaped and describe outcomes, not commits
- [ ] `npm run release:prepare -- X.Y.Z` passed
- [ ] CI passing on release branch
- [ ] Honesty pages re-verified: rating-coverage wording, video links, and site screenshots still match the current product and UI
- [ ] Breaking changes documented, with migration notes (if any)
- [ ] Release branch merged into `main` with a merge commit
- [ ] Tag pushed: `vX.Y.Z` — this publishes the release
- [ ] Installer image downloaded from the published link, checksum verified, and booted once

## Recommended First Release

If this is the first formal public release, start with:

- `v0.1.0` (initial usable release)

When compatibility commitments harden and upgrade paths are stable, move to:

- `v1.0.0`
