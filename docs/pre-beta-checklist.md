# Pre-Beta Checklist — Audit Follow-ups (July 2026)

**Status:** Temporary, branch-scoped working document — same convention as the former
`pre-beta-polish-handover.md`. Remove it (or replace it with pointers to the GitHub issues it became)
once the items below are done. Do not treat this as a long-lived roadmap doc.

**Origin:** The 2026-07-24 pre-release product audit (external user-journey review: landing page →
docs → install → first run), filtered down to the items the owner agreed to act on. Findings the
owner explicitly rejected or deferred are listed at the bottom under **Decided — do not re-raise**
so future agents don't resurface them.

**Copy rule for all site work in this batch:** headlines never name third-party companies
(DigitalOcean, Google, etc.). Concrete provider examples belong in body text only — MOS is
provider-neutral and the copy should feel that way.

## Mandatory workflow (from `AGENTS.md`)

- **Never work on `main`.** Branch from `staging` (`docs/<topic>`, `fix/<topic>`, `feat/<topic>`).
- **Update `CHANGELOG.md` `## [Unreleased]`** in the same branch; fold related tweaks into a few
  broad user-facing bullets, not one per checklist item.
- **Leave changes uncommitted for the owner to review and commit** (owner preference).
- Docs split: end-user content in `site/`, technical content in `apps/*/README.md`; no duplication.
- Verify before finalizing: `npm test`, `npm run typecheck`, `npm run build:client`, and a clean
  `site/` build for site changes. E2E/smoke suites are **human-run** — ask the owner.

---

## Tier 1 — Install path rework (fixes the one confirmed blocker)

- [x] **1. Retire the DigitalOcean guide; make "Install on any cloud server" the single, hardened
  cloud path.** *(docs + site, Medium)* — **Done 2026-07-24** (uncommitted, awaiting owner review):
  `digitalocean.mdx` deleted; `cloud-server.mdx` rewritten (web console primary, SSH alternative,
  closed-terminal recovery, migrated Backup-destination/billing notes, no cloud-init anywhere);
  sidebar, `getting-started.mdx`, `InstallPaths.astro`, and `first-start.mdx` swept; changelog
  updated. Owner dropped the planned redirect — the site has only been live a few days, so the old
  URL has no bookmarks worth preserving.

  **Problem.** Cloud installs (`cloud-init` / `public-vps` front doors) generate a one-time owner
  claim token stored in `/etc/mos/secrets/owner-claim.env` and printed only in the installer's
  terminal finish banner (`scripts/installers/bootstrap-contract.cjs:253`, `:552`). Owner setup
  403s without it (`suite-manager/backend/src/server/http-app.cjs:448`); the frontend reads it only
  from the URL query (`suite-manager/frontend/src/features/setup/useSetupSession.ts:81`). The
  DigitalOcean guide's cloud-init flow tells users to visit the plain URL — a dead end at the most
  important step. Also owner preference: no provider names in headlines/page titles.

  **Fix.**
  - Delete `site/src/content/docs/docs/install/digitalocean.mdx`; remove its sidebar entry in
    `site/astro.config.mjs`; add an Astro redirect `/docs/install/digitalocean/` →
    `/docs/install/cloud-server/` (the page is deployed and may be indexed/bookmarked).
  - Rework `site/src/content/docs/docs/install/cloud-server.mdx` as the one cloud guide, with the
    **provider web console as the primary flow** (owner-tested on DigitalOcean: create the droplet
    → click "Launch Droplet Console" → paste the one-liner → wait ~10 minutes → the finish banner
    prints the one-time setup link right there in the browser):
    1. Create the server (Ubuntu 24.04, 2 vCPU / 4 GB+).
    2. Open your provider's **web console** (browser terminal); log in as root if asked.
    3. Paste `curl -fsSL https://get.myownsuite.org | sudo bash` and wait.
    4. **Open the Finish-setup link the installer prints — it carries a one-time setup key.**
       Never instruct users to visit the plain `https://home.<ip>.sslip.io/` URL (that reproduces
       the 403).
    - Keep **SSH from your own computer** as the equivalent alternative for those who prefer it
      (same command, same printed link) — also the fallback for providers whose console is a
      VNC-style screen with poor paste support.
    - Practical caveats to cover in the guide: some web consoles don't support paste (→ use SSH);
      the printed link is long — click it if the console makes links clickable, otherwise copy it
      exactly (item 2's paste-the-key field covers mis-copies).
    - **Remove cloud-init "Option B" entirely** (it is the dead-end flow: the banner goes to
      `/var/log/cloud-init-output.log` where no user will find it).
    - Claim phrasing: **"one command in a browser terminal — nothing to install on your
      computer"** — true as written; drop all "you never open a terminal" wording.
    - Keep DigitalOcean as a body-text worked example (provider dashboards differ; one real
      reference helps), without putting it in headings.
    - Migrate the DO guide's still-valuable content: the **Backup destination** note and the
      **billing/powered-off-droplet** note.
  - Sweep for stale references (`grep -ri "digitalocean\|cloud-init" site/src`): the sidebar,
    `getting-started.mdx` (LinkCard "Install on DigitalOcean" + "fully worked cloud example"),
    `site/src/components/InstallPaths.astro` ("Paste one command into a fresh Ubuntu 24.04 VPS,
    or use cloud-init user data" → web console or SSH; "SSH access, or cloud-init" requirement
    line; "DigitalOcean tested reference"), and any FAQ mentions. Body-text examples may stay;
    routes and headlines may not.

  **Acceptance.** A fresh-VPS install following only the rewritten page — via the provider web
  console, touching nothing but the browser — reaches owner-account creation without a 403; no
  site page routes cloud users to a plain (token-less) setup URL; no install path advertises
  cloud-init.

- [x] **2. (Recommended safety net, Small)** Handle the missing-claim case in the setup screen:
  when `/setup/status` returns `ownerClaimRequired: true` and the URL has no `claim` param, show
  "this install needs its one-time setup link" guidance (ideally with a paste-the-key field)
  *instead of* a form that fails only after submit
  (`suite-manager/frontend/src/features/setup/useSetupSession.ts:29-49`). The docs companion
  (reprint the link via `sudo cat /etc/mos/secrets/owner-claim.env`) already shipped with item 1 —
  see the guide's "Closed the terminal before opening the link?" section; only the frontend half
  remains.

  **Done 2026-07-24** (uncommitted, awaiting owner review): `OwnerSetupScreen` now has two states —
  opened without the key (cloud installs only), it shows guidance (open the printed Finish-setup
  link; or reprint via `sudo cat /etc/mos/secrets/owner-claim.env`) with a paste-the-key field that
  accepts the whole `MOS_OWNER_CLAIM_TOKEN=...` line; with a key, the normal form plus a quiet
  "Change key" footer covering mis-copied links. `ownerClaimRequired` is threaded through the
  session state; own-hardware installs see no change. Verified with `npm run typecheck` +
  `npm run build:client`. Docs left as-is on purpose: the guide's `?claim=` recovery URL works on
  every MOS version, while paste-on-screen only exists from the release carrying this change —
  once that release is out, the recovery section can be simplified to "open the suite address and
  paste the key".

---

## Tier 2 — Truth-in-claims batch

- [x] **3. Fix the three stale "only one app is rated" passages.** *(docs, Tiny)* All six catalog
  apps now carry posture grades; these pages still build their trust story on the number *one*:
  - `site/src/content/docs/docs/privacy/how-we-assess.md:12-13` — "One: Stirling PDF… we would
    rather publish one honest rating than six comfortable ones"
  - `site/src/content/docs/docs/privacy.md:30` — "one app (Stirling PDF) has a completed assessment"
  - `site/src/content/docs/docs/reference/app-packages.md:47` — "today that is `stirling-pdf`, and
    the other five read `review-required`"

  Per the new standing policy (item 4), wording can be unconditional ("every app in the catalog
  carries a published assessment") — **do not hardcode a count** that goes stale again.

  **Done 2026-07-24** (uncommitted, awaiting owner review): all three passages rewritten as
  unconditional coverage claims backed by the item-4 policy, no counts anywhere. A sweep found two
  more stale spots in `how-we-assess.md` — "one honest rating than six comfortable ones" (same
  section) and the singular "in the review we have published so far" under expiry — both fixed.
  The rewritten section also points out that external (outside-catalog) apps stay **External ·
  Unverified** and ungraded.

  **Correction round (owner, 2026-07-24):** dropped the "how many are rated" framing entirely —
  no counting question, no "currently"/"so far" hedging that plants the idea a catalog app might
  be unrated. Coverage is now definitional everywhere: *MOS catalog apps are assessed and receive
  a posture grade; assessment is a condition of catalog entry.* Applied across `how-we-assess.md`
  (section retitled "Every catalog app is rated"; intro and confidence wording aligned),
  `privacy.md`, `app-packages.md` (file-tree comment + trust paragraph), the docs index blurb,
  and `guides/apps.md`. "Not yet rated by MOS" phrasing now appears in docs only where it is
  about external/unreviewed installs.

- [x] **4. Codify the rating policy.** *(AGENTS.md, Tiny)* Owner decision, 2026-07-24: **no app
  enters the official catalog without a completed privacy posture review.** Add this to the app
  onboarding rules in `AGENTS.md` (alongside the manifest/README/dependabot requirements), so
  rating-related copy across site and docs can safely claim full coverage.

  **Done 2026-07-24** (uncommitted, awaiting owner review): new "Catalog Privacy-Review
  Requirement" subsection under AGENTS.md's Container and Versioning Rules — no catalog entry
  without a valid version/digest-bound `privacy-review.json`, and copy may claim full coverage
  unconditionally but must never hardcode an app count.

- [x] **5. Add a LICENSE.** *(root, Tiny — owner decision required)* There is no LICENSE file and no
  `license` field in `package.json`, while "free & open source" appears in the site header badge,
  FAQ, footer, docs index, and `privacy.md` (which also leans on it: "no way for us to quietly add
  any [telemetry], because the code is open source"). Technical testers check this within minutes.
  Owner picks the license (note several bundled apps are AGPL themselves); then add root `LICENSE`,
  the `package.json` field, and a README mention so GitHub shows it.

  **Prepared 2026-07-24, awaiting owner decision** — agent analysis: catalog apps are pulled as
  containers at install time, not vendored, so their licenses don't constrain the choice for MOS's
  own code; the real choice is AGPL-3.0 (keeps hosted forks open — matches the project ethos and
  what Immich, Vaultwarden, and Seafile core chose; sole-copyright-holder status keeps dual
  licensing possible later) versus Apache-2.0/MIT (maximally permissive, allows closed hosted
  forks). Agent recommendation: **AGPL-3.0**. Once decided: root `LICENSE`, `"license"` field in
  root `package.json`, and a README mention (the README gets its item-12 upgrade later anyway).

  **Done 2026-07-25:** owner chose **AGPL-3.0-only**. Added the unmodified GNU AGPLv3 text at root,
  the exact SPDX identifier in `package.json`, a README badge and plain-language license section,
  and a concise boundary for MOS/Funkyton branding and third-party app assets. The public site now
  has a Legal-section license page that renders the canonical root text, plus License links and
  plain-language AGPL messaging in the landing page's open-source section and footer.

- [x] **6. Rewrite the scaffolding-voiced app READMEs.** *(apps, Small)* These render verbatim on
  the public app pages under "Technical reference":
  - `apps/vaultwarden/README.md` — "pressure-tests generic package setup…" + the "Secret Management
    Caveat" roadmap prose, on the *password manager's* page.
  - `apps/stirling-pdf/README.md` — "intentionally boring… exists to prove package discovery", on
    the app `first-start.mdx` recommends as the warm-up; also stale "when the lifecycle engine
    exists".
  - `apps/seafile/README.md` — milder, but maintainer-voiced ("generated projections", "MOS scope
    notes"); tone-pass it while there.

  Rewrite as plain technical reference (what runs, ports/volumes/health, env, caveats); move
  roadmap talk to GitHub issues. **Warning:** package contents change ⇒ package **version bump**
  (CI enforces via `npm run apps:version:check`) **and owner-run catalog re-sign** before release.

  **Done 2026-07-24** (uncommitted, awaiting owner review): all three READMEs rewritten in the
  Radicale README's house style (Environment Variables / Volumes And Persistence / Health Check /
  Package Behavior / Current Limits); every technical fact preserved and checked against the
  manifests, scaffolding and roadmap prose removed. Packages bumped 0.2.0 → 0.2.1, privacy-review
  scopes re-stamped (version + digest), catalog regenerated; `apps:privacy:check`,
  `apps:privacy:monitor`, `apps:version:check`, and the catalog content check all pass.
  **Owner actions before release:** (1) run `npm run apps:catalog:sign` — the signature is stale;
  (2) create the GitHub issue for the Vaultwarden secret-management follow-up (issue text prepared
  by the agent; issue creation was permission-blocked) — the old README's "Secret Management
  Caveat" roadmap scope moves there.

- [x] **7. Release guardrail for claim-bearing pages.** *(RELEASING.md, Tiny)* Add one checklist
  line to the release flow: re-verify the "honesty pages" before tagging — rating coverage wording,
  video links, screenshots match current UI. This batch exists because claims lived in more places
  than the facts; make re-checking them a release step, not a memory.

  **Done 2026-07-24** (uncommitted, awaiting owner review): added to the copy/paste Release
  Checklist in `RELEASING.md`, between CI and upgrade notes.

---

## Tier 3 — Show, don't tell (assets & demonstration)

- [ ] **8. Record and embed the install walkthrough video.** *(owner + site, Small once recorded)*
  Record the exact flow the rewritten guide documents (item 1): provider web console → paste one
  command → wait → open the printed Finish-setup link → owner account → first app install → open
  the app. When published, update the three "on the way / planned" spots to link it:
  `site/src/components/Faq.astro:11`, `site/src/content/docs/docs/index.mdx:37`,
  `site/src/content/docs/docs/getting-started.mdx:76`. **Hosting consideration:** the site's
  privacy story ("served from your own server, never a CDN"; self-run analytics only) argues for a
  self-hosted file or at minimum a no-cookie embed — a plain YouTube iframe injects Google tracking
  into the page that promises otherwise.

- [x] **9. E2E-generated screenshots + an update script.** *(test + scripts + site, Medium)* All
  three current marketing screenshots are stale (`app-detail-install.png` predates the privacy-grade
  tile — the flagship feature is missing from its own screenshot; `backups.png` predates the
  unencrypted-exports notice and current copy; `app-catalog.png` has an old search placeholder).
  Fix the pipeline, not just the images:
  - Add named `page.screenshot()` captures at the right moments in the Playwright flows
    (`test/e2e`): app catalog, app detail with privacy tile, install stepper, backups screen,
    update review dialog, Connect visual.
  - Add an `npm run screenshots:update` script that copies the latest run's captures into
    `site/src/assets/screenshots/` (stable filenames so the site needs no changes per refresh).
  - E2E stays **human-run** per `AGENTS.md`; the script only harvests from the last local run.

  **Acceptance:** `backups.png` shows the current warning notice; `app-detail-install.png` shows
  the posture-grade tile; refreshing screenshots after a UI change is one test run + one command.

  **Done 2026-07-24** (uncommitted, awaiting owner review + one human-run capture pass):
  capture primitives in `test/e2e/support/screenshots.mjs` (best-effort — a failed shot logs a
  warning, never fails the regression) write stable-named PNGs to the ignored
  `test/e2e/screenshots/`. Hooks: `app-detail-install.png` (pre-install Seafile detail, untouched
  prefill state; override app via `MOS_E2E_SCREENSHOT_APP`) and `app-install-progress.png`
  (first install stepper of the run) inside `installAppViaUi`; `backups.png` (full page, current
  warning notice) after backup success; a "capture marketing screenshots" step in the full spec
  (post-connect, everything installed) shoots `app-catalog.png` (full page), `privacy-posture.png`
  (posture dialog open), `app-connect.png` (Connections section element shot, connected state),
  `app-setup-guide.png` (Radicale guide panel); `app-update-review.png` is opportunistic — any
  run whose lab has a compatible pending app update captures the Review-update dialog, runs
  without one keep the previous capture. Both Hyper-V configs now render at 1440×900 with
  deviceScaleFactor 2 so captures match the existing 2880px-wide site assets.
  `npm run screenshots:update` (new `scripts/screenshots-update.cjs`) harvests the last local
  run into `site/src/assets/screenshots/`, reports updated/added/not-refreshed, exits nonzero
  with guidance when no captures exist. Pipeline documented in `scripts/README.md` (+ a coverage
  line in `test/README.md`). **Owner action:** run `npm run e2e:full` then
  `npm run screenshots:update` once to mint the first fresh set (use a presentable owner email —
  whatever the lab shows lands in the published images), review, commit with the site.

- [x] **10. Expand the landing Tour / screenshot coverage.** *(site, Small)* Audit feedback: after
  the landing page alone, a visitor still can't picture what they get. With item 9's pipeline in
  place, add Tour entries (or a screenshot strip) for the product's most differentiated screens —
  candidates: privacy posture dialog, Connect plug-and-socket visual, a per-app setup guide, the
  app-update review dialog.

  **Done 2026-07-24** (uncommitted, awaiting owner review): `Tour.astro` is now data-driven — a
  seven-entry storytelling arc (browse the catalog → read the app page → check the privacy grade
  → connect apps → get guided onto your devices → approve updates → back it all up) where each
  entry names its screenshot file and renders **only if that screenshot exists**
  (`import.meta.glob` over `assets/screenshots/`). Today the site builds with the three existing
  shots; the four new entries (privacy posture "The privacy grade, with receipts", Connect "Apps
  that plug into each other", setup guide "Guided onto your other devices", update review
  "Updates you approve, not endure") appear automatically after item 9's first capture run — a
  partial screenshot set can never break the build or show a wrong image. New copy follows the
  definitional privacy message from item 3 and the honest update/backup claims from the docs.

- [x] **11. New landing section: external apps as a dual selling point.** *(site, Small–Medium)*
  Today the catalog's size (6) is visible but its *openness* isn't. Add a section making the
  external-install path a first-class pitch, aimed at two audiences at once:
  - **For users:** your favorite app isn't locked out — paste its GitHub repository URL and MOS
    shows exactly what you'd be trusting before anything installs (with a little technical
    tinkering). Link the existing external-install docs (`guides/apps.md`).
  - **For open-source publishers:** make your project MOS-installable and reach MOS users — link
    the packaging workflow in `skills/` and the existing example external-app repository.

  This also reframes the small catalog honestly: a curated, rated core plus an open edge.

  **Done 2026-07-24** (uncommitted, awaiting owner review): new `ExternalApps.astro` section
  ("Beyond the catalog — Your favorite app isn't locked out") placed directly after the catalog
  section so the reframe lands immediately: "a curated, privacy-rated core — not a wall". Two
  cards reusing the existing `.mos-panel.path` conventions: **For you** (preview-first external
  installs, honest trust framing, External · Unverified labelling, MOS restrictions, managed like
  any app; links `guides/apps.md#bringing-your-own-app`) and **For open-source publishers**
  (manifest/pinned-recipe packaging pitch; links `skills/add-mos-app/SKILL.md` on GitHub and the
  `MOS-external-app-example` repository). All claims cross-checked against `guides/apps.md`.

- [x] **12. GitHub README upgrade.** *(README.md, Small)* The repo is a discovery surface — site
  visitors (especially technical testers) click through and currently meet "self-hosted control
  plane", a directory table, and dev commands. Give it a massive visual and communication upgrade:
  brand banner/screenshot at the top, one plain-language paragraph on what MOS is, prominent links
  to myownsuite.org and the getting-started guide, license badge (after item 5) — then keep the
  existing developer map below for contributors.

  **Done 2026-07-24** (uncommitted, awaiting owner review): centered brand mark
  (`branding/my-own-suite-mark.png`) + tagline + Website/Get started/Docs/Changelog link row,
  one plain-language paragraph on what MOS is, the app-catalog screenshot (embedded from
  `site/src/assets/screenshots/` — refreshes automatically with item 9's pipeline), a
  "Why it's different" list (privacy grades with evidence, signed catalog + pinned packages,
  verified backups, Connect, bring-your-own-app + publisher packaging link), the one-line
  installer with an honest early-beta status note, then the unchanged developer content
  (repository map, local development, documentation map) plus an AGENTS.md pointer. No license
  badge yet — that lands with item 5 once the owner picks the license.

---

## Tier 4 — Pricing & sizing

- [ ] **13. "What it costs" docs page.** *(docs, Small)* Its own page (owner decision), referenced
  from the cloud-server guide, the own-hardware guide, and getting-started, so cost expectations
  are answered once and consistently:
  - Table: apps running × recommended VPS size × typical monthly price range (provider-neutral
    numbers; providers named only as body-text examples).
  - Own-hardware row: "only the electricity you use" (+ rough figure), linking to the own-hardware
    guide.
  - Honest note that heavy apps (Immich, ONLYOFFICE) want RAM headroom — this is currently a
    silent gap: the stated 2 vCPU / 4 GB minimum plausibly cannot run the advertised
    Seafile + ONLYOFFICE pair, and Immich alone wants 4 GB.
  - **Fix getting-started's cloud "trade" line while wiring the links** (owner request,
    2026-07-24): `site/src/content/docs/docs/getting-started.mdx` says the monthly bill is
    "(roughly the price of the subscriptions you're replacing)" — too specific a promise; the real
    cost varies with what people need. Rephrase to a neutral range and link this cost page from
    there once it exists.

---

## Tier 5 — Product polish

- [ ] **14. Suite Manager welcome page facelift.** *(frontend, Medium)* Design a proper landing
  experience for the owner — both states:
  - **First run:** keep "install your first app" + the three-step checklist front and center.
  - **Returning owner:** quicklinks, suite stats (apps running, last backup age, updates
    available), owner details — what's actually useful on each future login.
  - While in here, **verify the post-setup redirect target**: `useSetupSession.ts:55-62` currently
    sends a fresh owner from setup to `/` (the Homepage dashboard), not the Suite Manager main
    page; owner recollection differs. Confirm on a live install and make the landing destination
    an explicit decision.

- [ ] **15. App-install duration expectations.** *(frontend + docs, Small)* First installs of heavy
  apps can take up to ~10 minutes; nothing says so, and a user watching "Starting app" has no
  reassurance it isn't hung. Add the expectation everywhere the install process is described: the
  install stepper copy (`AppsScreen.tsx`), `guides/apps.md`, and first-start's "Good first steps".

- [x] **16. Explain the AI review process where the shield links.** *(docs, Small)* Every visible
  grade carries "AI-reviewed for MOS", and the dialog's "how MOS assesses" link lands on
  `site/src/content/docs/docs/privacy/how-we-assess.md` — which mentions AI-assisted vs
  human-authored but never defines the literal badge or describes the process. Add a short
  subsection: what the AI review workflow actually checks (evidence labels, config verification),
  what the badge text means, and the current human-review status. This is the first question a
  skeptical tester asks about the product's most differentiated feature.

  **Done 2026-07-24, pulled forward on owner request** (uncommitted, awaiting owner review):
  `how-we-assess.md` rewritten as one narrative — new "Humans pick the apps" section states the
  curation reality (human-chosen shortlist: open source, real-world adoption, battle-tested,
  actively maintained, privacy-respecting, run by us over time; assessment is the condition of
  catalog entry) and a new "Where AI fits in" section states the division of labor (people decide,
  AI does the long reading of source/config/ToS/privacy policies, re-done on every package
  update), why (that volume of reading is unrealistic to repeat by hand per version), what keeps
  AI work checkable (evidence labels + sources, fail-closed **Review required**, published open
  questions, recorded provenance: method/provider/model/workflow revision/commit), and the
  literal badge semantics: **AI-reviewed for MOS** = AI-assisted with no human sign-off (true of
  every published review today, all six are `ai-assisted`/`humanReviewed: false`); **Reviewed by
  MOS** appears only once a human authored or checked the review. The page links straight to the
  workflow source, `skills/assess-app-privacy/SKILL.md` on GitHub ("read it and you know precisely
  what the AI was told to do").

---

## Open questions (decide before or during beta)

- [ ] **OQ1 — Cloud backup story.** The current cloud instruction ("attach, format and mount a
  block-storage volume") requires exactly the terminal work the cloud pitch promises away. Options:
  1. **Provider snapshots as the documented default for cloud** (previous-gen MOS approach: "follow
     your provider's backup/restore procedure outside MOS"). Zero friction; but not a
     consistency-checked MOS backup, keeps you inside the provider's trust boundary, and doesn't
     cover provider exit. Needs an honest caveat + "snapshot before updates" guidance.
  2. **Browser download/upload of bundles** — no mounting; but bundles are unencrypted full-secret
     exports landing in a Downloads folder, and whole-suite bundles with photo libraries get
     impractically large.
  3. **Status quo** (block-storage mount) as the MOS-native, consistency-checked path — documented
     as an *advanced* option with a real provider walkthrough.
  4. **S3-compatible object-storage destination** — the standard long-term cloud answer; a new
     subsystem, not a beta item.

  Audit recommendation: short term **1 + 3** (snapshots as the default cloud guidance with the
  consistency caveat; block storage kept for advanced users), treat **4** as the real fix later;
  **2** is the weakest option for anything beyond small suites.

- [ ] **OQ2 — Communicating per-app resource needs in-product.** The cost page (item 13) answers
  sizing *before* install; undecided is the in-product half: how a user with a 4 GB server predicts
  whether the next app fits (catalog card badges with approximate RAM? app-detail figures? a
  suite-level "capacity" meter?). No decision yet — owner to pick a direction, possibly after
  tester feedback.

---

## Decided — do not re-raise

Owner decisions from the 2026-07-24 audit review:

- **Password recovery / owner account lifecycle** — post-beta; not part of early testing.
- **Railway "try it" demos stay low-key** — intentional (SEO/indexers/those who find them); do not
  promote them on the landing page.
- **No roadmap page** for early testers.
- **"One button" backup wording stays** — close enough to the real experience.
- **Own-hardware path is for technical users** — accepted hard truth; do not try to polish it for
  non-technical users (the prebuilt signed ISO remains a later bet).
- **Backups screen warning-first layout and install-failure UX are fine for early beta.**
- **Maintainer identity stays understated on the site** — deliberate.
- **Tester feedback is collected privately** — no in-product/docs feedback channel for now.
- **Headlines never name third-party companies** — provider examples live in body text only.
