---
name: land-app-updates
description: Land one or more finished app-update pull requests on staging in a single pass with a single catalog signature. Use when asked whether app-update pull requests are ready or safe to merge, to update their branches, to merge them, or when an app update does not show up on a server tracking staging.
---

# Land App Updates

`update-mos-app` produces an update branch. This skill takes every finished one to `staging` together. The agent does all the preparation on one local branch; the key holder signs once and pushes once.

## Why updates land together

`apps/catalog.json.sig` signs the whole catalog file. So:

- Any two update branches conflict in the signature, and so does a branch against a `staging` that moved.
- A signature made on an update branch is thrown away by the next merge. **Never sign on an update branch**, and never ask the key holder to.
- An update branch's CI is therefore red until it lands. Exactly two checks may fail, both naming the catalog signature: `Check app catalog and advisory feed` and `Check release metadata`. Any other failure is real. Before blaming the update for it, look at whether `staging` fails the same check: `gh run list --branch staging --workflow CI --limit 5`.

## 1. Start from a green staging

Check `gh run list --branch staging --workflow CI --limit 3` first. If staging is red, stop and say so: nothing landed on top of it can come out green, and the failure has to be fixed on staging before any update lands.

The lane in step 4 runs on the agent's machine. A failure that only shows on the CI runner's operating system is not caught there, so say which system the lane ran on.

## 2. Review each pull request yourself

The pull request's report is a claim, not evidence. For each open app-update pull request into `staging`, read the diff (`git diff origin/staging...origin/<branch>`) and confirm:

- It is not a draft, and its report and final review are posted.
- `@update <app>` and `@app-dr <app>` both passed, and the drill names the commit it ran on.
- Its image digests are what the registry serves for the stated versions.
- Nothing changed outside `apps/<app>/`, `apps/catalog.json` and `CHANGELOG.md`.
- The manifest diff is what the report says and no more: version, `appVersion`, and an `update` block whose `rollback` and `migrations` match the report's evidence.
- The privacy review moved with the pin, `outbound` gained no host without evidence, and `lastHumanReview` is untouched.
- The changelog has one bullet for the app, naming the package version the manifest has, with compatibility and rollback limits called out.

A pull request that fails one of these is left out and reported with the reason. Land the rest without it. No command block is written until this review and steps 3 and 4 are done for every pull request in it.

## 3. Find what staging changed underneath each one

```sh
git fetch origin
git log --oneline $(git merge-base origin/staging origin/<branch>)..origin/staging -- apps/<app>
```

No output means staging never touched the package: the drill still stands and the branch only needs its catalog rebuilt in step 4.

Any output means the pull request was built against an older package, and it needs all of this before it can land:

- **Version.** The package version must end above staging's, or no server is offered the update. Set it with `npm run apps:bump -- <app> --package-version <next patch above staging> --app-version <version>`, and make the `CHANGELOG.md` bullet name the same number.
- **Every pin.** A service staging added may build from the same image under another `Dockerfile.<service>`. All pins of one image move together; `apps:bump` refuses when one was left behind.
- **Everything staging added.** Read what is new on staging for this package (a service, a script, an integration, manifest fields) against the upstream changes the update crosses. The update's own review never saw it.
- **Both sides of the manifest.** Keep staging's additions and the update's changes; a conflict in the `update` block usually needs fields from each.
- **A new drill.** The package is no longer the one that was drilled. Leave this pull request out of the landing until `@update` and `@app-dr` pass on the new commit, and say so.

## 4. Build the landing branch

Work in a separate worktree so the owner's checkout is untouched, with its own `npm ci` (never a linked `node_modules`).

```sh
git worktree add <scratch>/landing -b chore/app-updates-<date> origin/staging
```

Merge each ready branch in turn with `git merge --no-ff origin/<branch>`. Resolve conflicts by rule, not by hand:

| File | Resolution |
| --- | --- |
| `apps/catalog.json` | Take either side, then `npm run apps:catalog` rebuilds it from the packages. |
| `apps/catalog.json.sig`, `apps/advisories.json.sig` | Take staging's. It is stale either way until step 6. |
| `apps/<app>/privacy-review.json` scope | Take either side, then `apps:bump` re-stamps it. Keep every evidence entry from both sides. |
| `CHANGELOG.md` | Keep both sides' bullets; one bullet per app. |

Then check the result once:

```sh
node scripts/app-package-catalog.cjs --check
npm run apps:privacy:check
node scripts/checks.cjs --lane workspace --keep-going
```

The only failures allowed are the two signature checks. Do not push the landing branch: the pre-push hook would refuse it for the missing signature, and nothing needs it on GitHub.

## 5. Report in a few lines

The maintainer reads this instead of the branches, so it is short and only carries what changes a decision:

- One line per pull request: **landing** or **left out**, with the reason for a left-out one.
- Loudly, each on its own line, only if it applies: a rollback that is `unsupported`, a new outbound host, a migration, anything that was changed on top of the pull request, and anything not verified.
- Then the block from step 6.

Leave out what passed, how the checks were run, and the story of how conflicts were resolved. "Nothing to flag" is a complete report for a clean update.

## 6. Hand the key holder one block

Written for the owner's shell and repository path, as one paste:

```sh
git switch staging
git merge --ff-only chore/app-updates-<date>
npm run apps:catalog:sign
git commit -m "Sign the catalog" apps/catalog.json.sig apps/advisories.json.sig
npm run apps:catalog:check && npm run release:check
MOS_SKIP_CHECKS=1 git push origin staging
git push origin --delete <each landed branch>
git branch -d chore/app-updates-<date> <each landed branch that exists locally>
```

That is the only signature and the only push that carries commits. Every such push runs the whole workspace lane in the pre-push hook, which takes minutes, so the block does not repeat it: step 4 already ran the lane on this exact tree, the signature commit changes nothing but the two `.sig` files, and the line before the push runs the two checks that depend on them. Use `MOS_SKIP_CHECKS` only under those conditions; if step 4's run was not on the landing branch's final commit, drop it and let the hook run. Deleting branches runs no checks.

GitHub marks each landed pull request merged once staging contains its commits, so nothing is merged in the browser. CI on staging still runs everything after the push. Remove the worktree afterwards.

## 7. Confirm it arrived

A server on the staging track offers the updates after its next catalog refresh. If it does not, compare the commit its catalog was fetched at with `origin/staging` before suspecting the fetcher: an update that is not on staging is never offered.
