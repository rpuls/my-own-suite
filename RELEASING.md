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
- A flashable installer image and its SHA256, hosted on `downloads.myownsuite.org`

These files must agree with each other and with the release tag. The pipeline writes the
image and the release notes; the rest comes from `npm run release:prepare`.

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

One command and a tag. Everything that can be checked is checked by one gate, and
everything that can be automated happens when the tag is pushed.

1. Ensure `staging` is green (CI passing), contains the batch you want to release, and
   has nothing uncommitted.
2. From `staging`, prepare the release:

   ```bash
   npm run release:prepare -- X.Y.Z
   ```

   This creates and switches to `release/vX.Y.Z`, rewrites `VERSION` and
   `releases/stable.json`, moves everything under `## [Unreleased]` into a dated
   `## [X.Y.Z]` section, and then runs the release gate against what it just wrote. It
   refuses to leave a prepared-but-invalid tree behind, and it refuses to start from a
   dirty working tree so that unrelated work cannot ride along in the release commit.
   It does not commit, so review the diff.
3. Commit the prepared files, open the PR into `main`, and merge it with a **merge commit**.
4. Optional, and worth it when the installer or the pipeline itself changed: go to
   **Actions → Release → Run workflow** on `main`. That runs the same gate and the same
   installer build, uploads to `dry-run/` in the bucket, and stops before publishing. It
   rehearses the part of a release a moved tag cannot undo.
5. Tag and push:

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

### What you decide, and what is decided for you

Only three things are yours:

1. **The version number.** SemVer, per the rules above. No script can judge this.
2. **Whether the changelog reads like release notes.** The gate checks entries exist, not
   that they are worth reading.
3. **When to tag.** Everything after that is automatic.

Everything else is enforced. Do **not** hand-edit `VERSION`, `releases/stable.json`, or the
changelog headings as part of a release — `release:prepare` owns those files, and editing
them yourself is how they drift apart. Write changelog *entries* under `## [Unreleased]`
as you work, and let the prepare step move them.

### When a release goes wrong

Nothing is published unless every job passed, so a failed pipeline leaves only a tag.

```bash
git tag -d vX.Y.Z                 # local
git push origin :refs/tags/vX.Y.Z # remote
```

Fix the problem on a branch, merge it to `main` through a PR, then tag the new merge
commit. Never move a tag onto a different commit while it is still pushed — delete it
first, so nobody ever holds two different builds calling themselves the same version.

If the pipeline failed *after* the upload but before publishing, the R2 object for that
version already exists. Re-running writes over it, which is fine: same version, same
source commit, same bytes.

If a release was published and is wrong, publish `X.Y.Z+1`. Do not delete or rewrite a
published release — someone may already be running it, and `releases/stable.json` is what
installed servers compare themselves against.

## Hotfix Workflow

Use for urgent production-impacting issues.

1. Branch from released tag `vX.Y.Z`:
   - `hotfix/vX.Y.(Z+1)`
2. Apply minimal fix.
3. Update changelog with hotfix entry.
4. Tag and release `vX.Y.(Z+1)`.
5. Merge hotfix back into `main`.

## The installer image

Since `v0.16.0`, every release publishes a flashable installer image. There is nothing to
do per release — this section is here so the wiring is understood, not operated.

**Where it lives.** Cloudflare R2 bucket `mos-downloads`, served publicly through the bound
custom domain `downloads.myownsuite.org`:

| Path | Written by | Meaning |
| --- | --- | --- |
| `vX.Y.Z/my-own-suite-installer-vX.Y.Z.iso` | tag push | the published download |
| `vX.Y.Z/SHA256SUMS` | tag push | checksum beside the bytes |
| `dry-run/…` | manual Run workflow | rehearsal only, never linked |

The checksum is also attached to the GitHub Release, and **that is the copy to trust**: one
served from the same host as the image it describes proves only that the host agrees with
itself.

**Why R2 and not a release asset.** The Ubuntu 24.04 base makes the image ~3.2 GiB, and a
GitHub release asset is capped at 2 GiB. R2 has no egress charge, and the account already
exists for the site.

**Why the S3 API and not `wrangler`.** `wrangler r2 object put` sends one request; a file
this size needs multipart upload. The workflow uses `aws s3 cp`, which R2 speaks natively.

**Credentials.** `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are repository secrets — R2's
S3 credentials, from an Object Read & Write token scoped to this bucket. They are *not*
`CLOUDFLARE_API_TOKEN`, which belongs to the site deployment. `CLOUDFLARE_ACCOUNT_ID` is
shared with the site deployment and forms the S3 endpoint.

**Storage.** The free tier is 10 GB, so roughly three images. Nothing prunes them today.
When it matters, add an R2 lifecycle rule and repoint the superseded releases' notes at the
current download before their objects expire.

### What the image is not allowed to contain

One build is flashed by everyone who downloads it, so anything decided while the image is
built is shared by every machine installed from it, and extractable by anyone who has the
file. The pipeline enforces two things before the multi-gigabyte build even starts, and both
failures are release-stopping:

- the seed must pin the **tag**, never a branch — otherwise the image installs whatever that
  branch happens to be later;
- the seed must carry **no password**. The installed machine generates its own console login
  on first boot and hands it over once through Suite Manager.

Setting `LINUX_PASSWORD` still pins a password for a lab machine you build yourself. An
image built that way must never be shared.

## Release Checklist (Copy/Paste)

Almost everything that was once on a checklist is now enforced — the gate fails if it is not
true. What is left is the judgement a script cannot make, plus the one check that needs a
human with a USB stick.

Before tagging:

- [ ] Version chosen using the SemVer rules above
- [ ] Changelog entries describe outcomes an updating operator would want to read, not commits
- [ ] Breaking changes carry migration notes
- [ ] Honesty pages re-verified: rating-coverage wording, video links, and site screenshots
      still match the current product and UI
- [ ] `npm run release:prepare -- X.Y.Z` passed and the diff was reviewed
- [ ] Release branch merged into `main`

After tagging:

- [ ] Release page shows the download link, the SHA256, and that version's changelog section
- [ ] Image downloaded from the published link and its checksum matches the one on the
      release page
- [ ] Image flashed and booted at least once, reaching a working Suite Manager

The last item is the only part of a release nothing can verify for you. Until someone boots
a published image, "the pipeline succeeded" means the bytes were produced and uploaded — not
that they install.
