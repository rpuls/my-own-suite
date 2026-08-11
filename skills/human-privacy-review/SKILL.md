---
name: human-privacy-review
description: Walk a MOS app package's privacy assessment item by item with a human reviewer and record the outcome, converting an AI-authored review into one a person has actually verified. Use before setting provenance.humanReviewed to true, when an assessment's conclusions rest on documentation rather than observed behaviour, or when a review is challenged.
---

# Human Privacy Review

`provenance.humanReviewed: true` is a claim that a person examined this package
and stands behind the result. It is not a formatting step and not a rubber
stamp on an agent's output.

Run this when a package's assessment was written by an agent, when an existing
assessment is challenged, or when a first-time package needs one. It
complements `assess-app-privacy`, which produces the assessment; this procedure
tests one.

Work one item at a time and stop after each for the reviewer's call. Do not
present a finished document for approval — that reproduces the problem this
procedure exists to fix, except that the result now carries a human's name.

## Standing rules

- Missing evidence never becomes a favourable result. `unknown` is a valid
  answer and forces `review-required`.
- Configuration is not behaviour. A setting that should prevent a request is
  evidence about intent, not about the network.
- Label every conclusion `observed`, `configured`, `documented` or `inferred`,
  and keep the label honest about how it was obtained.
- The posture is derived from the dimensions, never chosen. Vocabulary and
  derivation live in `apps/README.md` and
  `suite-manager/backend/src/apps/package-contracts.cjs`.
- Record what was not examined as explicitly as what was.

## Gate 0 — Is there an assessment to test?

A first-time package has none. This procedure tests a claim, so with nothing to
falsify it collapses into writing and approving one document in a single pass —
the failure it exists to prevent, now carrying a human's name.

Run `assess-app-privacy` first and review its output. Write that draft from
documentation, source and shipped configuration, before anything has been
observed, so its claims are on record ahead of the evidence that will confirm or
break them. Leave `provenance.humanReviewed` false, keep `confidence` no higher
than the method supports, and expect the posture to derive to `review-required`
until the observed items are done. Then start at Gate 1 and test it.

## Gate 1 — Is the package current?

A review binds to one exact version. Reviewing a stale package produces a
signed statement about software nobody runs.

If the package trails current upstream, stop and run `update-mos-app` first,
then review the result. Re-stamp `scope`: package version, package digest,
source revision, and every component version and artifact digest.

## Item 1 — What does the software itself say it will contact?

Many servers ship a machine-readable egress allow-list: a Content Security
Policy, a proxy allow-list, a pinned endpoint table. Read it in the source at
the pinned version.

This is the cheapest high-yield check. It is written by the developers, it is
exhaustive for the client surface it governs, and it routinely names hosts no
documentation page mentions.

Every host it names is a disclosure item. For each, decide: reached by the
server, by the client, or not at all.

## Item 2 — Which shipped defaults imply a network call?

Read the default configuration in the source, not the documentation. Walk every
default that is enabled and ask what it does at runtime.

Features added in recent upstream releases are the usual gap: the review was
written against an older feature set and nobody revisited it.

## Item 3 — Who actually serves the downloads?

Follow every fetch to the party that answers it. Do not stop at the vendor's
name for it.

Check the dependency that performs the download, not only the app's own code. A
hardcoded endpoint inside a transitive dependency is still an endpoint the
operator's server contacts, and it is chosen by neither the app nor MOS.

Record the operator, and whether artifacts are integrity-pinned. A pinned digest
against an unexpected host is a disclosure problem, not a tampering one — say
which one you have.

## Item 4 — Run it and watch the wire

The item that separates this procedure from another documentation pass.

### How the session runs

Get this shape right before touching anything, because getting it wrong costs
the reviewer's time rather than yours.

**You run the containers and the capture. The reviewer only uses a browser.**
Do not hand the reviewer a script to run, a host to ssh into, or a set of
commands to paste. Have the rig built, started, and its controls verified
*before* you involve them; then give them one URL, credentials, and a list of
what to exercise. They drive the app and save a HAR, say when they are done, and
you collect and analyse. Anything else turns a seven-minute browsing session
into an afternoon.

Verify the controls landed *before* handing over. A capture that was already
broken wastes the whole session, and you only learn that at the end.

### Requirements

- The MOS runtime projection, not upstream's compose. The review binds to the
  MOS package. **This does not require an installed MOS host**: the projection
  is the output of Suite Manager's own projection code, so render it from there
  and start the containers the way the host agent does. A hand-written compose
  file that resembles the manifest is not the projection, and the difference is
  exactly where an unnoticed divergence hides.
- A logging resolver as the containers' only upstream resolver, so every name
  they try to resolve is recorded.
- A packet capture covering everything crossing the package-network boundary.
  Taking it from inside each container's own network namespace also attributes
  every byte to one container and catches its DNS to the container runtime's
  embedded resolver on loopback, which never crosses the bridge.
- **A control.** Inject a deliberate outbound request from inside the
  containers and confirm it appears. Without a control, a silent log is
  indistinguishable from a broken capture, and reporting it as silence is the
  same failure this procedure exists to prevent. Label control traffic in the
  evidence so it can never be misread as the app's behaviour.
- Exercise the features under review — first boot, account creation, and the
  real workload. Optional features do not reveal themselves at idle.
- **A saved HAR, not a remembered one.** The reviewer watching the network panel
  and reporting what they saw is real evidence, but it cannot be re-analysed and
  supports no claim about headers, cookies or bodies. Ask for the file while the
  session is still open; afterwards it costs another session.

Collect every log and capture *before* stopping or removing anything. Evidence
collection must never be the step that destroys the evidence.

Report the window, the packet count, and what was contacted. A short window is
a limit on the finding, not a clean result. Note which scheduled tasks fell
inside the window and which did not; an hourly job in a ten-minute capture was
not observed doing nothing, it was not observed at all.

## Item 5 — Which direction does the data flow?

Contact with an external host is not the same as data leaving. Measure bytes in
and out per container across the session.

A large inbound total against a negligible outbound one distinguishes fetching
resources from exporting user content, and it tests the promise that actually
matters: that the user's own data stays put.

State the limit plainly: unless TLS was decrypted, this bounds behaviour by
destination and volume, and is not a claim about request contents.

## Item 6 — Server or client?

A server-side capture says nothing about what the browser or mobile app does
from the user's own device. Anything the server merely hands to a client — a
tile URL, an embed, a script origin — is outside it.

Name the boundary in the review. Do not let server-side silence stand in for a
result about clients.

## Item 7 — Is every "MOS disabled it" claim applied consistently?

For each control MOS uses, list everything else that same mechanism governs.
For each of those left at its upstream default, state why.

A package that disables one setting through a mechanism while leaving other
externally-reaching settings in the same mechanism untouched does not support
an unqualified claim that its telemetry is disabled. Either extend the control,
or narrow the claim to what was actually done.

## Item 8 — Policies, licence, publisher

Retrieve the licence, Terms and privacy policy for the pinned version from
primary sources, with URLs and retrieval dates. Note the publishing entity and
any ownership change since the last review, which is a reassessment trigger in
its own right.

## Item 9 — Derive the posture

Fill each dimension from the evidence gathered, then let the posture follow.
If a dimension moves, the posture moves with it. A grade that survives scrutiny
is worth more than a flattering catalog.

If the honest reading lowers the grade, lower it.

## Item 10 — Sign-off

Only after every item has an answer the reviewer has confirmed:

- Add the observed findings to `evidence[]` with accurate labels.
- Move `confidence` only as far as the method supports, and scope it to what was
  actually observed.
- Record what was not examined in `openQuestions`. Remove questions the run has
  answered; do not leave stale ones as hedging.
- Set `provenance.humanReviewed: true` and name the reviewer.

Then run `npm run apps:privacy:check`, regenerate the catalog with
`npm run apps:catalog`, and check it with `npm run apps:catalog:check`.
Regenerating invalidates the committed Ed25519 signature, so the signature half
fails until the key holder runs `npm run apps:catalog:sign`. Report re-signing
as a required pre-merge step. Never edit `.sig` files.

## Recording evidence

App packages accept a closed set of files, so condensed observed findings belong
in `privacy-review.json` `evidence[]`, where they travel with the installed
package snapshot. Keep raw captures and logs out of the repository; cite the run
and keep it reproducible from the pinned digests instead.
