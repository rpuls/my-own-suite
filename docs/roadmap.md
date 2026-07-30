# MOS Roadmap

**Status:** durable. This is the only forward-looking document in the repository.

It holds **shape**: why a theme exists, what "done" means for it, and roughly when. It does not hold
status. Every item links to a GitHub issue, and the issue is the only place progress is recorded — so
this file cannot rot into a stale checklist the way the four planning documents it replaced did.

| This file | GitHub Issues | `docs/decisions.md` | `CHANGELOG.md` |
| --- | --- | --- | --- |
| Themes, gates, sequencing, open questions, what we decided against | Task state, progress, evidence | Contracts and invariants that shipped | What shipped, for updaters |

Rules for editing:

- No checkboxes. No "done 2026-xx-xx" notes. No implementation evidence. Those belong in the issue.
- One line per item. If it needs three paragraphs, it needs an issue.
- Moving an item between horizons is normal. Marking it done here is not — close the issue instead.
- When a theme's gate is met, delete the theme and record the contract in `docs/decisions.md`.

Consolidated 2026-07-30 from `pre-beta-checklist.md`, `beta-main-cutover-checklist.md`,
`backup-restore-reliability-plan.md`, and the app-package refactor plan. Current release: 0.15.0.

---

## Now — Beta hardening

The window before and during private tester recruitment. Recovery leads, because a privacy-first
platform whose backups are unencrypted full-secret exports is the sharpest dissonance in the product.

### A. Recovery an owner can trust without an asterisk

**Gate:** an owner sets a passphrase once, backups run on a schedule with retention, cloud installs
have one documented destination story, and no restore screen shows a raw 502 or an internal path.

- **A1 — Authenticated-encryption bundle format and recovery-key lifecycle.** Payload integrity,
  encryption at rest, authentication, key export, and the key-loss/rotation workflow are one design
  problem, not four features; today a bundle is a plaintext export of every owner and app secret.
  *(Large — flagship)*
- **A2 — Scheduled and pre-update backups, retention, last-known-good protection.** Manual-only
  backup means the newest thing an owner has is whenever they last remembered. *(Medium)*
- **A3 — Decide and document the cloud backup story.** See **OQ1** below; the decision is the work,
  the docs change is small. *(Small — needs owner decision)*
- **A4 — Restore-experience follow-ups from the July drills.** Serve a static "MOS is restoring"
  page from Caddy instead of a raw 502 during the control-plane outage; map journal phase IDs
  (`reconciling-apps`, …) to plain language in the interrupted-restore notice; say "the uploaded
  file" instead of leaking the internal temp filename; offer Mount for whole-disk filesystems, not
  only partitions. *(Small, bundled)*
- **A5 — Decide a cleanup story for anonymous Docker volumes.** Unlabeled, hash-named volumes left
  behind by removed app containers are outside MOS ownership by design, so restore correctly refuses
  to claim them — and nothing else ever removes them either. *(Small — needs a decision first)*

### B. Trust claims that survive DevTools

**Gate:** every visible privacy grade has a human behind it, no third-party cookie reaches an install
domain, and "what if myownsuite.org disappears" has a published answer.

- **B1 — Make first-entry review human, and AI the change detector.** Every published review is
  `ai-assisted` / `humanReviewed: false` today. That is disclosed honestly, but it is a discoverable
  gotcha on the single most differentiated feature. The fix is a process, not a backfill: **a human
  reviews an app before it enters the catalog, against a written checklist, and signs it** — which is
  roughly what already happens informally and needs to become defined and recorded. From then on, an
  app *update* is reviewed as a **diff against the last signed review**, which is the work AI is
  genuinely good at and the part that does not scale by hand. Anything the diff surfaces goes back to
  a human before the grade moves. The AI never authors a whole assessment, so no published review
  rests on an unreviewed machine judgement. Needs the checklist written, `assess-app-privacy` split
  into first-entry and update-diff modes, and the provenance schema extended to record which one ran.
  *(Medium)*
- **B2 — Replace sslip.io with self-hosted branded wildcard DNS.** `#192`. Google Analytics cookies
  land on install domains because sslip.io is not on the Public Suffix List — inert, but it
  contradicts the promise for anyone who opens DevTools. *(Medium)*
- **B3 — Sovereignty guarantee document.** Near-zero code: state what is already structurally true —
  no account, no license server, AGPL, catalog verifiable offline, per-install snapshots — plus an
  explicit "if this project vanishes, your suite keeps working and anyone can mirror it." Answers
  both the Cloudron-history question and the revenue-model question that launch will produce.
  *(Small)*

### C. What a tester hits in the first hour

**Gate:** a friend-tester can predict the cost and the install time, knows where they land after
setup, and never waits at a screen that looks hung.

- **C1 — Record and embed the install walkthrough video.** Provider web console → one command → the
  printed Finish-setup link → owner account → first app. Three site spots currently promise it as
  "on the way". Hosting must respect the page's own privacy claim — self-hosted file or a no-cookie
  embed, not a plain YouTube iframe. *(Owner-run)*
- **C2 — "What it costs" docs page.** Apps running × VPS size × monthly range, provider-neutral, with
  an own-hardware electricity row and an honest note that the stated 2 vCPU / 4 GB minimum plausibly
  cannot run the advertised Seafile + ONLYOFFICE pair. Also rewrites getting-started's overspecific
  "roughly the price of the subscriptions you're replacing" line. Must cover **disk capacity**, not
  only CPU and RAM: nothing in the docs currently says how much storage a plan includes, block storage
  is billed per GB at every provider, and app data cannot be moved off the root disk today — so a
  reader arriving from Google Photos has no way to predict either the size or the bill. This is where
  own hardware is the honest answer for large libraries. *(Small)*
- **C3 — App-install duration expectations.** First installs of heavy apps take up to ~10 minutes and
  nothing says so; a user watching "Starting app" has no reason to believe it isn't hung. Install
  stepper copy, `guides/apps.md`, first-start. *(Small)*
- **C4 — Returning-owner welcome screen, and settle the post-setup redirect.** First-run state is
  handled; the returning-owner state has no design — quicklinks, apps running, last-backup age,
  updates available. While in there, confirm on a live install whether a fresh owner should land on
  the Homepage dashboard or Suite Manager, and make it an explicit decision. *(Medium)*
- **C5 — Finish suite user management in Settings.** `#130`. Owner password change shipped in the
  current Unreleased set; re-scope the issue to what remains rather than leaving it open as written.
  *(Small)*

---

## Alpha gate — the bar before MOS is called an alpha

The beta notice promises that if the project proves its worth and graduates to an alpha, every module
goes through full verification by human engineers. This section is the rest of that promise: the
things a prototype is allowed to skip and an alpha is not. **Nothing here is a beta blocker** — it is
the list that keeps "we'll harden it at alpha" from being a sentence nobody wrote down.

### AL-S — Security hardening

- **AL1 — Host OS patching.** MOS updates itself and it updates the apps, and nothing updates Ubuntu;
  an install running for months is quietly behind on kernel and TLS fixes while the Updates screen
  says everything is current. Enable unattended security upgrades at bootstrap, and surface host patch
  state where owners already look for updates. *(Small)*
- **AL2 — Full-disk encryption for own-hardware installs.** The installer uses a plain disk layout, so
  the "safe in your own house" claim currently survives everything except someone carrying the safe
  out of the house. Needs a decision on the unlock model for a headless machine — passphrase at boot,
  TPM-backed, or network-bound — before it is buildable. *(Large — needs a decision first)*
- **AL3 — Sign-in hardening either side of the second factor.** Raise the owner password hashing cost
  to current guidance, and persist the login throttle so restarting the service does not reset an
  attacker's budget. Both are small and independent of the MFA question in **E5**, which is the other
  half of this gate. *(Small)*
- **AL5 — Close the installer's placeholder-credential window on USB installs.** The autoinstall seed
  sets the machine account from a committed placeholder hash and the real generated password is
  applied later by first-boot `chpasswd`, while the Ubuntu installer has already enabled SSH password
  authentication. Between those two moments the account's password is whatever that public hash
  matches. Sixteen obvious candidates do not match it and its shape suggests hand-authored filler, so
  the account is probably unopenable — "probably" is the problem. Fix by setting the account to a
  genuinely locked value and confirming the installer accepts it on a real boot, or by applying the
  real password within the install phase rather than at first boot. *(Small — solution not yet
  determined)*
- **AL6 — Trusted HTTPS on own hardware immediately after install, with no domain to buy.** Today a
  self-hosted suite serves plain HTTP until the owner buys a domain and moves its DNS to Cloudflare,
  so the owner password is first set over an unencrypted connection and secure-origin apps do not work
  at all. **Depends on B2** — it is only buildable once MOS operates its own wildcard DNS zone.
  Shape: derive a per-install name under the MOS zone; publish an A record pointing at the server's
  **LAN** IP (a public name resolving to a private address is legitimate and is how comparable
  platforms do this); let Caddy solve DNS-01 against the MOS zone using a credential MOS holds rather
  than one the owner supplies; keep `http://home.mos.home` as the recovery door. Two things to settle
  before building: routers and resolvers with DNS-rebinding protection will refuse the answer and need
  a documented per-device override, and **publishing a record per install means the zone operator
  learns an install exists** — a telemetry-shaped fact that must be designed down (one wildcard per
  install, no per-app records) and disclosed in the privacy policy, or it contradicts "we don't know
  that you installed it". The existing Cloudflare flow stays for owners bringing their own domain.
  *(Large)*

### AL-A — Access

- **AL4 — View-only household access to the Home dashboard.** Homepage is reachable only through the
  owner session, so the only way to let a partner or housemate use the dashboard today is to hand over
  the owner password — which is also the credential that can install and run code as root. A view-only
  role that reaches the dashboard and its app tiles and nothing in Suite Manager. Deliberately narrow:
  this is not multi-user, LDAP, or SSO, which stay declined. *(Medium)*

### AL-R — Backup and restore hardening

- **AL7 — Recovery onto a new machine at the version the bundle expects.** The backup guide tells an
  owner to restore onto the MOS version the bundle records; the hosted installer only ever produces
  the current `main` tip. On the worst day, those two instructions disagree. `--repo-ref` already
  accepts a tag and is the mechanical escape hatch, but it needs a clone and Node on a second machine
  — which the fire took too. Decide the real shape: a version argument the hosted installer accepts, a
  restore path that migrates forward from an older bundle (**D2**), or documenting the escape hatch
  and accepting it. *(Medium — solution not yet determined)*

### AL-C — Storage

- **AL8 — Per-app volume placement.** App data lives on whichever disk the container runtime uses, so
  the system disk is the ceiling and attaching a larger volume does nothing for it. Documented as a
  manual pre-install mount for now (`cloud-server.mdx`), which does not help an existing install and
  cannot vary per app. The durable answer is MOS choosing where each app's volumes live. *(Large)*

### Carried in — already tracked above, and alpha gates rather than 1.0 wishes

**A1** encrypted bundles · **A2** scheduled backups · **B1** human sign-off on privacy reviews ·
**D1** object-storage destination · **E3** signed release and installer artifacts · **E4**
owner-facing security events · **E5** passkeys and the MFA shape · **F1** runtime hardening of app
containers. Alpha is where these stop being roadmap and become the bar.

---

## Next — Toward 1.0

### D. Recovery breadth

**Gate:** recovery no longer requires a mounted drive, a matching version, or an owner reading a
journal.

- **D1 — S3-compatible object-storage destination with resumable transfer.** The real long-term
  answer to the cloud backup question, and a new subsystem rather than a beta item. *(Large)*
- **D2 — Restore compatibility migrations and a bare-metal recovery runbook.** Restore currently
  requires a compatible installed MOS and reuses the software already on the box; recreating the
  recorded version is not implemented. *(Medium)*
- **D3 — Automatic rollback after a failed restore.** Today a safe failure leaves a journal, a rescue
  generation, and a blocked agent awaiting typed acknowledgment — correct, but manual by design until
  interruption behaviour was proven. It now is. *(Medium)*
- **D4 — Periodic verification restores.** A backup nobody has restored is a hypothesis. *(Medium)*
- **D5 — Per-app consistency hooks for databases and large media stores.** Container stop is a blunt
  consistency boundary; it held in the drills, but a `mysqldump`-class hook is the durable answer.
  *(Medium)*

### E. Platform confidence

**Gate:** every durable security control MOS records is visible to the owner, and no failure mode in
the update or install path requires SSH.

- **E1 — Human-run platform E2E for the app-package pipeline.** Update, interruption, offline,
  restore, and compromised-source scenarios, including a representative multi-service database app on
  real hardware. The last genuinely open item of the app-package epic. *(Medium — owner-run)*
- **E1b — Close the restore-E2E session blind spot.** The Hyper-V suite keeps its pre-backup cookie
  across a restore, so the assertions pass while the human sign-out path the restore actually forces
  goes untested. Re-authenticate after creating the checkpoint backup. *(Small)*
- **E2 — Recoverable managed updates when the repo checkout is dirty.** `#122`. A generated file can
  dirty the production checkout and wedge updates behind a Git error message that assumes a
  developer. *(Medium)*
- **E3 — Signed release and installer artifacts.** The catalog and advisories are Ed25519-signed; the
  release and the pipe-to-shell installer that delivers everything are not. *(Medium)*
- **E4 — Owner-facing security event read surface.** `security_events` durably records throttled
  sign-ins, refused packages, download-bound trips, and failed catalog refreshes — with no route and
  no UI, so nothing is ever shown to the owner. A failing catalog refresh is the quiet one: the cache
  keeps serving while MOS stops learning which installed packages have advisories. *(Small)*
- **E5 — Passkeys, and decide the MFA shape.** `#164`. Research passkey-as-second-factor vs
  passkey-as-sole-credential and bring a recommendation before building. *(Medium)*

### F. Runtime hardening

**Gate:** a compromised app is bounded by the runtime, not only by the install gate.

- **F1 — Harden catalog app runtimes.** No `--memory`, `--cpus`, `--pids-limit`, `--read-only`,
  `--cap-drop`, `--security-opt`, or `--user` is set anywhere today, and single-service apps sit on
  the default bridge. MOS enforces strictly at the gate and not at all at runtime; doing both is
  achievable and unmatched among comparable platforms. *(Large)*

### G. Ops hygiene

**Gate:** the claim-drift class the July 2026 audit found cannot recur silently.

- **G1 — Automated stale-wording checks for active documentation.** The audit's core finding was that
  claims outlived the facts and lived in more places than the facts did. *(Small)*
- **G2 — Site link, accessibility, and clean-build checks in CI.** Clean-build landed with the
  deployment cutover; links and a11y did not. *(Small)*

---

## Later — Bets and deferred

- **L1 — Restore the shared SMTP relay.** A MOS1 capability (v0.9.0) absent in MOS2; apps half-work
  without outbound mail — Vaultwarden hints at it, Seafile notifications are off. Relay presets only,
  explicitly **not** a mail server. *(Medium)*
- **L2 — Advanced User mode.** `#124`. A project-wide opt-in for technical and experimental controls,
  starting with the Homepage escape hatches (`custom.css`, `custom.js`, `docker.yaml`). Overlaps the
  existing "Advanced details" convention in `AGENTS.md`; unify rather than add a second concept.
  *(Medium)*
- **L3 — Communicate capacity in-product.** See **OQ2**. Folds in resource estimation/preflight for
  Immich, Seafile, and ONLYOFFICE. *(Medium)*
- **L4 — One proven local VM/filesystem snapshot integration.** Fast same-machine rollback; never a
  replacement for portable recovery. *(Medium)*
- **L5 — Partial restore.** Deliberately excluded from the first architecture. *(Large)*
- **L6 — Wider version, hardware, and architecture compatibility.** Packages may now declare
  `architectures` and incompatible hosts are refused at install; arm64 catalog support is the actual
  work. *(Large)*
- **L7 — Prebuilt signed ISO for own hardware.** The standing bet behind accepting that the
  own-hardware path is for technical users. *(Large)*
- **L8 — More DNS providers for the certificate flow.** Cloudflare is the only supported provider, and
  it is the one dependency in MOS that is a hard requirement for a feature rather than a distribution
  channel — which makes it the one people argue about. Caddy's `libdns` modules cover deSEC, Hetzner
  DNS, Porkbun, Gandi, Njalla, DuckDNS and more; compiling a second provider in and adding a picker
  turns "requires Cloudflare" into "supports Cloudflare or …". deSEC is the strongest first addition:
  a free German nonprofit built for exactly this. *(Medium)*
- **L9 — ACME-DNS delegation as the advanced certificate path.** The owner adds one `_acme-challenge`
  CNAME once, and MOS thereafter talks only to a narrow service that can answer challenges and nothing
  else. Strictly better than today's model, where MOS asks for a token that can edit the owner's whole
  zone. Self-hostable, and the option this audience respects most. *(Medium)*

---

## Open questions

Owner decisions pending. Options are already worked out — what is missing is a choice.

**OQ1 — The cloud backup story.** Today's cloud instruction ("attach, format and mount a
block-storage volume") requires exactly the terminal work the cloud pitch promises away.

1. **Provider snapshots as the documented cloud default** (the MOS1 approach). Zero friction, but not
   a consistency-checked MOS backup, keeps the owner inside the provider's trust boundary, and does
   not cover provider exit. Needs an honest caveat plus "snapshot before updates" guidance.
2. **Browser download/upload of bundles.** No mounting, but bundles are unencrypted full-secret
   exports landing in a Downloads folder, and whole-suite bundles with photo libraries get
   impractically large.
3. **Status quo** — block-storage mount kept as the MOS-native, consistency-checked path, documented
   as *advanced* with a real provider walkthrough.
4. **S3-compatible object storage** (**D1**) — the standard long-term answer, not a beta item.

*Standing recommendation from the July 2026 audit:* ship **1 + 3** now (snapshots as the default
cloud guidance with the consistency caveat, block storage retained for advanced users) and treat
**4** as the real fix. **2** is the weakest option for anything beyond a small suite. Note that
**A1** changes the arithmetic on option 2.

**OQ2 — Communicating per-app resource needs in-product.** **C2** answers sizing *before* install.
Undecided is the in-product half: how an owner with a 4 GB server predicts whether the next app
fits. Catalog card badges with approximate RAM? Figures on app detail? A suite-level capacity meter?
Possibly best decided after tester feedback.

---

## Decided — do not re-raise

Owner decisions. Future agents and reviews should not resurface these.

- **Password recovery / owner account lifecycle** — post-beta; not part of early testing.
- **Railway "try it" demos stay low-key** — intentional, for search and for people who find them. Do
  not promote them on the landing page.
- **No public roadmap page** for early testers.
- **"One button" backup wording stays** — close enough to the real experience.
- **The own-hardware path is for technical users** — an accepted hard truth. Do not try to polish it
  for non-technical users; the prebuilt signed ISO (**L7**) is the later bet instead.
- **Backups screen warning-first layout and install-failure UX are fine for early beta.**
- **Maintainer identity stays understated on the site** — deliberate.
- **Tester feedback is collected privately** — no in-product or docs feedback channel for now.
- **Headlines never name third-party companies** — provider examples belong in body text only.
- **Do not chase a mail server** — a decade-deep moat at the nearest comparable platform and a
  tarpit. **L1** is a relay, not a mail server.
- **Do not chase multi-user, LDAP, or SSO.** Single-owner is a position, not a gap: the platform has
  one owner, apps have their own users, families live inside their Immich and Seafile accounts. The
  one carve-out is **AL4**, view-only dashboard access at alpha — because "share the dashboard with
  the household" currently means sharing the credential that can run code as root. That is an access
  fix, not the start of a user system.
- **Do not chase app-count parity, a DNS-provider matrix, or monitoring graphs.**

---

## Reconciled during the 2026-07-30 consolidation

Recorded so nothing looks lost. These were open boxes in the retired planning documents that are not
backlog:

- **Shipped, dropped from the backlog:** package-aware transactional per-app updates and rollback
  (app-package epic, Phase 5); Stable tagged-release updates and installed-version metadata (v0.13.0);
  the secure one-time first-owner claim; tested cloud HTTPS and reference firewall automation.
- **Accepted deviations, not gaps** (recorded in `docs/decisions.md`): restore is validated-then-
  in-place after a complete rescue copy rather than an inactive-target swap; restore reuses the
  installed MOS software with the bundle's validated package snapshots rather than recreating the
  recorded MOS version, surfacing a version mismatch as a validation warning; activation is in-place,
  so verification gates the success report rather than the activation.
- **Verified, never ticked:** the app-package plan's 11-point security review checklist and its seven
  completion gates were executed against real code by the 2026-07-16 multi-agent branch review and
  hold, and the branch's six showstoppers and eight major defects were all fixed and re-verified.
- **Now a release step, not a backlog item:** re-checking claims, links, screenshots, and version
  references at release time lives in `RELEASING.md`.
