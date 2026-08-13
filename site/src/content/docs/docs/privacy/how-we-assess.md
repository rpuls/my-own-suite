---
title: How MOS assesses app privacy
description: How the MOS privacy posture grade and per-dimension verdicts are produced.
---

MOS Privacy Posture is a bounded, evidence-backed assessment of one exact app
package. Every app in the official catalog carries one - it is part of how an
app becomes a catalog app at all. The assessment is not a legal audit,
certification, guarantee, or claim that an app never makes a network request.

## Humans pick the apps

Every catalog app is chosen by a person before any assessment runs. An app has
to earn the shortlist on its own merits: genuinely open source, adopted and
battle-tested in the real world, actively maintained, and privacy-respecting
in how it is built - software we have run ourselves, over a longer stretch of
time, and are happy to stand behind. An app that does not clear that bar is
not "in the catalog with a bad grade"; it is simply not in the catalog.

The assessment comes on top of that curation, and it is a condition of entry:
an app joins the catalog when its review is done, not before. So every app you
can install from the catalog carries a posture grade, with its evidence
published.

Apps you install from outside the catalog are a different thing: they are
labelled **External · Unverified** and never receive a grade, because we have
not reviewed them.

## What the assessment covers

The assessment is bound to the package version and digest, immutable source
revision, upstream component versions, and available artifact digests. It covers
the server package MOS ships. Desktop and mobile clients, cloud editions, and
third-party API clients are excluded unless the assessment names them explicitly.

We score five dimensions:

- **Out of the box** - installed the way MOS ships it and used normally, does
  anything leave your server at all.
- **Who decides** - if something does, who settled that, and whether you can
  change it.
- **Accounts** - whether an outside account is needed to use the app.
- **Data processing** - whether your data is processed off your machine.
- **Policies** - which terms and policies apply beyond the software license.

Each contributes 0-2 points. The five points add up to an overall **A-to-D
privacy grade** shown on the shield: **A** (9-10), **B** (7-8), **C** (4-6),
**D** (0-3), where A is best. A sixth dimension, **confidence**, records how
well the evidence actually supports the other five. It carries no points, but
it is not decoration: if we cannot state our confidence, there is no completed
assessment - and without one, an app does not enter the catalog.

## The four labels

The label on an app comes from the first two dimensions alone, and only from
the four combinations that describe a state an app can really be in:

- **Private by default** - nothing leaves, because the app has no outside
  touchpoint to begin with.
- **Privacy configured** - it had one, and MOS switched it off before you ever
  saw it. MOS's job is to pick the right default so you do not have to think
  about it.
- **Your choice** - something does leave, the app itself has a setting that
  stops it, and we judged the trade-off genuinely yours to make. We pick the
  default we think suits most people and tell you where the switch is.
- **External dependency** - something leaves and nothing in the app stops it.
  We reviewed that and accepted it as the price of the feature; the evidence
  says what leaves, who receives it, and why.

The label is derived, never chosen. The remaining three dimensions describe the
app and count toward the grade, but they cannot move the label, so no reviewer
can reach a friendlier badge by rewording a fact. Missing evidence is never
scored in an app's favor, and an unfinished assessment does not produce a label
at all: an app with unresolved questions stays out of the catalog rather than
appearing with a cautious-looking one.

## Evidence and confidence

Every favorable assessment includes concrete evidence. Claims are labeled as
**observed**, **configured**, **documented**, or **inferred**. We prefer package
and runtime evidence over marketing language. A supported setting that disables
known analytics is evidence for that control, but is not proof of complete
network silence. Open questions and untested boundaries stay visible.

## Where AI fits in

The division of labor is simple: people decide, AI reads. Which apps are worth
considering, what the five dimensions are, what counts as evidence, and the
fail-closed rules above are human decisions. What AI does is the long reading
behind each assessment - source code and package configuration, terms of
service, privacy policies, upstream documentation - and it does that reading
again when an app package updates. That work is real and it is enormous:
repeating all of it by hand for every version of every app is not realistic,
and pretending otherwise would produce staler reviews, not better ones. So we
use AI where it genuinely helps, and say so.

The workflow is built so AI-read evidence stays checkable rather than taken on
faith. Every claim must carry one of the evidence labels above and name its
source; configuration claims point at the actual package files; an unsettled
fact leaves the assessment unfinished rather than resolving into a favorable
default; and open questions are published, not smoothed over. Each review also records
its provenance: the review method, the AI provider and model, the exact
workflow revision it ran under, and the repository commit. The workflow itself
is open source like everything else:
[`assess-app-privacy`](https://github.com/rpuls/my-own-suite/blob/main/skills/assess-app-privacy/SKILL.md)
in the repository is the exact instruction set every assessment runs under -
read it and you know precisely what the AI was told to do.

The shield tells you which kind of review you are looking at. **AI-reviewed
for MOS** means the assessment was AI-assisted and no human has signed it
off - that is the honest state of every review published today. **Reviewed by
MOS** appears only once a human has authored or checked the review, with the
posture dialog spelling out the method (for example "AI-assisted review,
human-checked"). AI assistance is never presented as human sign-off.

## Updates, expiry, and advisories

The assessment installed with an app stays attached to that exact package
snapshot. A newer repository review does not silently replace it. Package,
policy, ownership, telemetry, or outbound-dependency changes and review expiry
trigger reassessment.

Every assessment carries an expiry date - six months out, in the reviews we
have published so far - and our own repository checks flag a lapsed review for
reassessment. Today that flag reaches us, not you: a lapsed review still
displays on your server as it was written. We would rather say that plainly
than imply a freshness guarantee we do not yet enforce where you can see it.

MOS may publish a signed advisory when new evidence affects reviews already
installed on servers. If Suite Manager cannot confirm a fresh signed advisory
feed, it warns that the absence of an advisory should be treated as unknown.

## Package-provided claims

Manifest privacy notes are labeled as package-provided and not independently
verified. Only the structured Privacy Posture assessment receives the MOS
evidence-backed grade.
