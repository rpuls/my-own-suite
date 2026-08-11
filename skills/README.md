# Repository skills

These public, versioned skills make MOS app review procedures inspectable:

- [`add-mos-app`](./add-mos-app/SKILL.md) onboards a manifest-driven package and requires an initial privacy assessment.
- [`update-mos-app`](./update-mos-app/SKILL.md) reviews every upstream release crossed, including breaking changes, migrations, rollback, and privacy changes.
- [`assess-app-privacy`](./assess-app-privacy/SKILL.md) reviews version-specific telemetry, external services, Terms, privacy policies, and supporting evidence.
- [`human-privacy-review`](./human-privacy-review/SKILL.md) walks an assessment item by item with a human reviewer before `provenance.humanReviewed` may be set to true.

The resulting **MOS Privacy Posture** is an evidence-backed technical assessment, not a legal audit, certification, or guarantee. Assessments must identify their app scope, sources, review date, procedure revision, AI model when runtime-reported, and human-review status. Unknown facts remain unknown.

MOS disables known optional telemetry where a packaged app provides a supported setting. Upstream behavior varies by app and version, so public claims must link back to current package evidence instead of promising that every upstream app is telemetry-free.
