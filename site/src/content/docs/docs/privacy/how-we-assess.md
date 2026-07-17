---
title: How MOS assesses app privacy
description: How the MOS privacy posture score and per-dimension verdicts are produced.
---

MOS Privacy Posture is a bounded, evidence-backed assessment of one exact app
package. It is not a legal audit, certification, guarantee, or claim that an app
never makes a network request. Apps without a completed assessment show **Not
yet rated by MOS** instead of receiving a favorable score.

## How many apps are rated right now

One: Stirling PDF. Every other app in the catalog is unrated and says so, both
here and on its tile inside your own server.

That number is small because the assessment is real work bound to an exact
package version, and because we would rather publish one honest rating than six
comfortable ones. It will grow app by app. Until an app's rating appears,
treat it as unreviewed - that is exactly what the tile is telling you.

## What the assessment covers

The assessment is bound to the package version and digest, immutable source
revision, upstream component versions, and available artifact digests. It covers
the server package MOS ships. Desktop and mobile clients, cloud editions, and
third-party API clients are excluded unless the assessment names them explicitly.

We score five dimensions:

- **Telemetry** - whether the app reports usage or diagnostics anywhere.
- **External services** - whether features depend on outside services.
- **Accounts** - whether an outside account is needed to use the app.
- **Data processing** - whether your data is processed off your machine.
- **Policies** - which terms and policies apply beyond the software license.

Each contributes 0-2 points to the **0-10 posture score** shown on the shield.
A sixth dimension, **confidence**, records how well the evidence actually
supports the other five. It carries no points, but it is not decoration: if we
cannot state our confidence, the app is not rated.

The overall label is derived from the dimension verdicts rather than chosen
independently. Any dimension that is unknown or unclear - confidence
included - forces **Review required**. Missing evidence is never scored in an
app's favor.

## Evidence and confidence

Every favorable assessment includes concrete evidence. Claims are labeled as
**observed**, **configured**, **documented**, or **inferred**. We prefer package
and runtime evidence over marketing language. A supported setting that disables
known analytics is evidence for that control, but is not proof of complete
network silence. Open questions and untested boundaries stay visible.

## Review provenance

The posture dialog says whether an assessment was AI-assisted or human-authored
and whether a human reviewed it. AI assistance is not presented as human sign-off.
Stored provenance also records the workflow revision and repository commit.

## Updates, expiry, and advisories

The assessment installed with an app stays attached to that exact package
snapshot. A newer repository review does not silently replace it. Package,
policy, ownership, telemetry, or outbound-dependency changes and review expiry
trigger reassessment.

Every assessment carries an expiry date - six months out, in the review we have
published so far - and our own repository checks flag a lapsed review for
reassessment. Today that flag reaches us, not you: a lapsed review still
displays on your server as it was written. We would rather say that plainly
than imply a freshness guarantee we do not yet enforce where you can see it.

MOS may publish a signed advisory when new evidence affects reviews already
installed on servers. If Suite Manager cannot confirm a fresh signed advisory
feed, it warns that the absence of an advisory should be treated as unknown.

## Package-provided claims

Manifest privacy notes are labeled as package-provided and not independently
verified. Only the structured Privacy Posture assessment receives the MOS
evidence-backed score.
