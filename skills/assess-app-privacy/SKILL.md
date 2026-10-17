---
name: assess-app-privacy
description: Assess a MOS app version's telemetry, external services, account dependencies, data processing, Terms of Service, privacy policy, and technical evidence; assign an evidence-backed MOS Privacy Posture and write or refresh the package privacy assessment. Use for new apps, app updates, policy-change alerts, stale reviews, or privacy documentation claims.
---

# Assess App Privacy

Produce a bounded assessment of one exact MOS app-package candidate. Bind it to the independent package version, package digest, immutable source revision, upstream component versions, and artifact digests. Do not describe it as a legal audit, certification, or guarantee.

## Required sources

Read `apps/README.md`, the assessment contracts in `suite-manager/backend/src/apps/package-contracts.cjs` (the canonical document shape, dimension vocabulary, and posture derivation), the app manifest, Dockerfiles, runtime configuration, and existing `privacy-review.json` first. Browse current primary upstream sources: release notes, server documentation, telemetry configuration, Terms of Service, privacy policy, license, and source code when documentation is insufficient.

Prefer observed package/runtime evidence over upstream marketing. Label every conclusion `observed`, `configured`, `documented`, or `inferred`. Record uncertainty as `unknown`; never turn missing evidence into a favorable result.

## Workflow

1. Identify every packaged upstream component and immutable image digest or version.
2. Separate server behavior from web, desktop, and mobile client behavior.
3. Review known optional and required outbound requests, update checks, crash reports, usage analytics, push services, maps, AI services, SMTP, object storage, and other integrations.
4. Verify which supported settings MOS uses to disable optional telemetry. Record exact package evidence. Do not claim network silence from a configuration setting alone.
5. Review upstream Terms, privacy policy, license, publishing legal entity, effective dates, and account requirements. Record direct primary-source URLs and retrieval dates.
6. Classify the dimensions defined in `apps/README.md`. Derive the overall posture mechanically; do not select it by intuition.
7. Record `outbound`: every host the app contacts in normal use as MOS ships it, before the owner turns anything on. For each, give `host` (exact, `*.domain` when the hosts vary, or `*` for behaviour that follows stored content), `from` (`server` or `browser`), `purpose` (what it fetches or sends, and when, in plain words) and `receiver` (who operates it). Owners read this list before they install and when an update changes it. It is empty exactly when `defaultEgress` is `none`, and the E2E `network` step fails on any host it does not name, so ground it in a capture: `npm run e2e -- @app-cycle <app>` writes one to `network/report.md`.
   Optionally record `security`: a few evidence entries on the app's own published vulnerabilities and how the package as MOS runs it meets them. Leave out risks every self-hosted app shares, such as exposing it to the internet.
8. Record provenance. Use the runtime-reported provider/model identifier when available and `unknown` otherwise. Never guess a model version. Never write `lastHumanReview`: it records a person's review, and only `skills/human-privacy-review` sets it. Drop a leftover `provenance.humanReviewed` or `provenance.humanReviewer` when rewriting a review.
9. Write the candidate package's `apps/<app>/privacy-review.json`, update its compact manifest `privacy` block, and document package-owned telemetry controls. This review travels with the package snapshot when installed.
10. Run `npm run apps:privacy:check`, `npm run apps:catalog` after changing a review, `npm run apps:catalog:check`, and relevant manifest tests.

## When an update needs a person

A person reviews an app when it enters the catalog. Updates are reviewed by AI and keep that `lastHumanReview`. Add an entry to `awaitingHumanReview` (`appVersion`, `date` as YYYY-MM-DD, and a `finding` of one or two plain sentences) only when the update changes what happens to the owner's data:

1. A new party receives data by default: a new company or service, not a new host of a receiver already listed.
2. Data that stayed on the server now leaves it, such as uploads, content sync or telemetry switched on by default.
3. The posture or any dimension gets worse.
4. The project changes hands or terms in substance: the licence leaves open source, the company is acquired, or an account becomes mandatory.

Never add one for a new version, a major included; a feature that does not touch where data goes; a new host of a listed receiver; a reworded policy; a fixed security bug; a dependency bump; or anything the package already switches off.

The test is whether an owner who chose this app because of its review would want to know before trusting it with more data. "Maybe" is not yes: put it in `openQuestions` instead. Expect a few entries a year across the whole catalog, not one per update. Owners see every entry as a warning on the app, so a list that fills with small things teaches them to ignore it and buries the reviewer; a missed nuance costs less, because the next human review reads the whole document. Never remove an entry: only a human review clears them.

## Catalog signing

Regenerating the catalog after any review or manifest change invalidates the committed Ed25519 catalog signature, so the signature half of `apps:catalog:check` fails until the key holder runs `npm run apps:catalog:sign` (prompts to paste the key). If you do not hold the signing key, that specific failure is expected: report re-signing as a required step before merge. Never work around it by editing `.sig` files or leaving the regenerated catalog uncommitted.

## Change monitoring

Treat a policy content or effective-date change, upstream ownership change, app update, telemetry-setting change, new outbound dependency, or expired review as a reassessment trigger. A changed page hash signals review; it does not prove improvement or regression.

The repository review describes the latest available package. An installed MOS instance must display the review preserved in its installed package snapshot, not silently substitute the latest repository review. Use a separate advisory when new evidence invalidates reviews attached to already-installed package versions.

## Wording

Use: "MOS disables known optional telemetry where the packaged app provides a supported setting." Keep upstream behavior scoped to the assessed version and evidence. Never use "telemetry-free", "only you hold the keys", or equivalent absolutes unless separately proven for the exact stated boundary.
