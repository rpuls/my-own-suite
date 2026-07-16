---
name: assess-app-privacy
description: Assess a MOS app version's telemetry, external services, account dependencies, data processing, Terms of Service, privacy policy, and technical evidence; assign an evidence-backed MOS Privacy Posture and write or refresh the package privacy assessment. Use for new apps, app updates, policy-change alerts, stale reviews, or privacy documentation claims.
---

# Assess App Privacy

Produce a bounded assessment of one exact MOS app-package candidate. Bind it to the independent package version, package digest, immutable source revision, upstream component versions, and artifact digests. Do not describe it as a legal audit, certification, or guarantee.

## Required sources

Read `apps/README.md`, `schemas/app-privacy-assessment.schema.json`, the app manifest, Dockerfiles, runtime configuration, and existing `privacy-review.json` first. Browse current primary upstream sources: release notes, server documentation, telemetry configuration, Terms of Service, privacy policy, license, and source code when documentation is insufficient.

Prefer observed package/runtime evidence over upstream marketing. Label every conclusion `observed`, `configured`, `documented`, or `inferred`. Record uncertainty as `unknown`; never turn missing evidence into a favorable result.

## Workflow

1. Identify every packaged upstream component and immutable image digest or version.
2. Separate server behavior from web, desktop, and mobile client behavior.
3. Review known optional and required outbound requests, update checks, crash reports, usage analytics, push services, maps, AI services, SMTP, object storage, and other integrations.
4. Verify which supported settings MOS uses to disable optional telemetry. Record exact package evidence. Do not claim network silence from a configuration setting alone.
5. Review upstream Terms, privacy policy, license, publishing legal entity, effective dates, and account requirements. Record direct primary-source URLs and retrieval dates.
6. Classify the dimensions defined in `apps/README.md`. Derive the overall posture mechanically; do not select it by intuition.
7. Record provenance. Use the runtime-reported provider/model identifier when available and `unknown` otherwise. Never guess a model version. Record human review separately.
8. Write the candidate package's `apps/<app>/privacy-review.json`, update its compact manifest `privacy` block, and document package-owned telemetry controls. This review travels with the package snapshot when installed.
9. Run `npm run apps:privacy:check`, `npm run apps:catalog` after changing a review, `npm run apps:catalog:check`, and relevant manifest tests.

## Catalog signing

Regenerating the catalog after any review or manifest change invalidates the committed Ed25519 catalog signature, so the signature half of `apps:catalog:check` fails until the key holder runs `MOS_CATALOG_SIGNING_KEY=<key path> npm run apps:catalog:sign`. If you do not hold the signing key, that specific failure is expected: report re-signing as a required step before merge. Never work around it by editing `.sig` files or leaving the regenerated catalog uncommitted.

## Change monitoring

Treat a policy content or effective-date change, upstream ownership change, app update, telemetry-setting change, new outbound dependency, or expired review as a reassessment trigger. A changed page hash signals review; it does not prove improvement or regression.

The repository review describes the latest available package. An installed MOS instance must display the review preserved in its installed package snapshot, not silently substitute the latest repository review. Use a separate advisory when new evidence invalidates reviews attached to already-installed package versions.

## Wording

Use: "MOS disables known optional telemetry where the packaged app provides a supported setting." Keep upstream behavior scoped to the assessed version and evidence. Never use "telemetry-free", "only you hold the keys", or equivalent absolutes unless separately proven for the exact stated boundary.
