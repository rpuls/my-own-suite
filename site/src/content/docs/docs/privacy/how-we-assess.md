---
title: How MOS assesses app privacy
description: How the MOS privacy posture score and per-dimension verdicts are produced.
---

:::note
Documentation TBD — this page is a placeholder. It is linked from the posture
score dialog in Suite Manager and on the app pages, and will be filled in
before the first published app reviews.
:::

Every app in the catalog gets a structured privacy review before it can show a
posture score. The review looks at five dimensions of the packaged app as MOS
ships it:

- **Telemetry** — whether the app reports usage or diagnostics anywhere.
- **External services** — whether features depend on outside services.
- **Accounts** — whether an outside account is needed to use the app.
- **Data processing** — whether your data is processed off your machine.
- **Policies** — which terms and policies apply beyond the software license.

Each dimension is scored 0–2, adding up to the **0–10 posture score** shown on
the shield. Anything the review could not establish counts as 0 — unknowns are
never scored in an app's favor. An app without a completed review shows
**Not yet reviewed** rather than a score.

The full methodology — evidence requirements, how reviews are bound to the
exact package version you install, review provenance (AI-assisted versus
human-checked), and how advisories can flag a published review — will be
documented here.
