# Pre-Beta Polish — Handover / Work Plan

**Status:** Temporary, branch-scoped working document. Remove it (or replace with a pointer to the
GitHub issues it became) once the items below are done. Do not treat this as a long-lived roadmap doc
— it exists to hand a concrete batch of improvements to the next agent.

**Origin:** A pre-tester presentation + deployment-friction review (July 2026), done before inviting a
mixed group of testers — some software developers, most non-technical but higher-educated office
workers who use SaaS tools (Notion, Google Workspace) daily but do **not** use terminals, Docker, or
sysadmin concepts. Every item below is framed against that dual audience.

**The core finding:** the public **marketing site is more polished than the product's first five
minutes.** The website charms people; the in-product first-run flow still carries developer
scaffolding and jargon. The highest-value work is closing that gap, plus removing one large,
self-inflicted deployment-friction contradiction in the install docs.

---

## How to use this document

1. Read the **Mandatory workflow** box below before touching anything.
2. Work top-down: the checklist is **ordered by value** (how many testers each item saves from a bad
   first impression / how much friction it removes). Tier 1 items will otherwise generate identical
   feedback from *every* tester — do those first.
3. Each item is self-contained: problem, evidence, why it matters, concrete fix, acceptance, effort.
4. Line numbers marked *(verified)* were confirmed against the code during the review. Line numbers
   marked *(approx — confirm)* came from a sub-agent sweep; open the file and confirm the exact
   location before editing, as the code may have shifted.
5. Tick the checkbox when an item is done and its acceptance criteria pass.

### Mandatory workflow (from `AGENTS.md`)

- **Never work on `main`.** Branch from `staging`: `feat/pre-beta-polish` (or per-item
  `fix/<topic>` / `docs/<topic>` branches merged into `staging`).
- **Update `CHANGELOG.md` `## [Unreleased]` in the same branch.** Fold related tweaks into a few
  broad, user-facing bullets — do **not** add one bullet per item here. Suggested groupings:
  - *Changed:* "Cloud install docs now use the hosted one-line installer as the primary path."
  - *Changed:* "First-run and onboarding screens rewritten in plain language with clearer next steps."
  - *Fixed:* "Corrected landing-page privacy wording for rented cloud servers."
- **Leave changes uncommitted for the owner to review and commit** (owner preference — the owner
  reviews and commits personally; do not commit or push).
- **Docs single-source-of-truth:** end-user content lives in `site/`; technical content lives in
  `apps/*/README.md`. Don't duplicate across them.
- **Verify before finalizing:** `npm test`, `npm run typecheck`, `npm run build:client`, and for
  site changes a clean `site/` build (`cd site && npm ci && npm run build`, or trust the `MOS Site`
  CI job). E2E/smoke suites are human-run — do **not** run them automatically; ask the owner and
  request only the relevant failure output.

---

## Value-ordered checklist

### Tier 1 — Fix before inviting testers (every tester hits these)

- [ ] **1. Rewrite cloud install docs around the hosted one-liner.** Removes a git/Node.js wall and a
  plain-HTTP downgrade. *(docs, Medium)*
- [ ] **2. Owner setup: add confirm-password field.** Prevents a silent typo locking the owner out
  of the only privileged account. *(frontend, Small)*
- [ ] **3. Replace the placeholder Suite Manager dashboard with a real "install your first app" +
  first-run checklist.** Kills a dead-end and the total absence of first-run guidance. *(frontend,
  Small–Medium)*

### Tier 2 — Strongly recommended before wider testing

- [ ] **4. Fix the "only you hold the keys" cloud overclaim** on the landing page. *(site, Tiny)*
- [ ] **5. De-jargon the Backups screen** (empty state + opening warning placement). *(frontend, Small)*
- [ ] **6. De-jargon the app catalog search + "Posture score" label.** *(frontend, Small)*
- [ ] **7. Reorder the landing page** so apps/tour precede install mechanics. *(site, Small)*
- [ ] **8. Demote the Customize YAML editor behind "Advanced";** make the guided "Add to Homepage"
  dialog the default surface. *(frontend, Medium)*

### Tier 3 — Polish (batch together)

- [ ] **9. Reconcile the cost framing** ("$20–25/month" vs. "a couple of coffees"). *(site, Tiny)*
- [ ] **10. Humanize the secure-transport failure message** in setup. *(frontend, Small)*
- [ ] **11. Route the primary "Get started" CTA** to the guided flow rather than the raw command.
  *(site, Tiny)*
- [ ] **12. Minor render nit** in the DigitalOcean guide (missing blank line). *(docs, Tiny)*

### Later / bigger bets (out of scope for this batch — file as GitHub issues)

- [ ] **13. Prebuilt, signed installer ISO download** to remove Git/Node/Docker from the own-hardware
  path. Already on the post-cutover list as "Signed release and installer artifacts."
- [ ] **14. Password recovery story** (recovery code at setup, or a documented recovery-from-backup
  runbook). Item 2 is the stopgap; this is the real fix.

---

## Tier 1 — Detailed

### 1. Rewrite cloud install docs around the hosted one-liner

**Problem.** The product makes a verified promise on the landing page —
`curl -fsSL https://get.myownsuite.org | sudo bash`, "paste one command into a fresh Ubuntu 24.04
VPS" — but **that one-liner appears nowhere in the docs**. Every install guide routes users through a
much heavier path (`git clone`, install Node.js 22, `npm run install:render`).

**Evidence.**
- Hosted installer `infrastructure/installer-endpoint/core.mjs` *(verified)*: **self-discovers the
  public IPv4** via `api.ipify.org` (line ~17) and renders with `--front-door public-vps`, which
  provisions **trusted HTTPS** (Caddy). It needs nothing pre-installed on the user's machine.
- `get.myownsuite.org` appears **only** in `site/src/components/InstallPaths.astro` *(verified via
  repo-wide grep)* — not in any doc.
- `site/src/content/docs/docs/getting-started.mdx` *(verified)*: the "What you need" table lists
  *"A computer with Git and Node.js 22"* for the cloud column, while a note lower on the same page
  says *"Cloud servers install with the one-line installer."* The page contradicts itself.
- `site/src/content/docs/docs/install/digitalocean.mdx` *(verified)*, labeled *"the fastest path,"*
  uses `git clone` + `npm run install:render -- --target cloud-init` and — per its own "Good to
  know" — serves the suite over **plain HTTP**. So the documented path is heavier **and** less
  secure than the un-documented one-liner (which gets HTTPS).
- `site/src/content/docs/docs/install/cloud-server.mdx` *(verified)*: same render-based flow.

**Why it matters.** A tester reads "paste one command," clicks into the guide, and hits "install Git
and Node and clone a repo." For the non-technical half that's a wall; the developers will ask why
they're building a payload locally when a hosted installer exists. It's the single largest
self-inflicted friction point on the whole journey.

**Fix.**
- Make the hosted one-liner the **primary** cloud path in `getting-started.mdx`, `digitalocean.mdx`,
  and `cloud-server.mdx`.
  - DigitalOcean: replace the clone/render/cloud-init steps with either (a) "create the droplet, SSH
    in, paste the one command," or (b) "paste the one-liner into DO's *Initialization scripts*
    (cloud-init) box" — the installer self-discovers the IP, so the user never needs to know it in
    advance.
  - Generic cloud: "SSH into your fresh Ubuntu 24.04 server and run the one command."
- Remove **"Git + Node.js 22"** from the cloud column of the `getting-started.mdx` "What you need"
  table (still legitimately needed for the own-hardware ISO build — keep it there).
- Keep the `install:render` flow, but **demote** it to an "Advanced / inspect-before-you-run /
  air-gapped" note. It's a valid power-user option, just not the default.
- Reconcile the HTTPS story: the one-liner path gives trusted HTTPS on `home.<ip>.sslip.io`; update
  the "this quick path serves plain HTTP" caveats accordingly.

**Acceptance.** A non-technical reader following the DigitalOcean guide never installs Git or Node,
never clones a repo, and reaches a **trusted-HTTPS** owner-setup screen. The getting-started page no
longer contradicts itself. `site/` builds clean.

**Files.** `site/src/content/docs/docs/getting-started.mdx`,
`site/src/content/docs/docs/install/digitalocean.mdx`,
`site/src/content/docs/docs/install/cloud-server.mdx`. Cross-check against
`infrastructure/installer-endpoint/core.mjs` and `scripts/installers/render-bootstrap.cjs` so the
documented behavior matches the installer.

---

### 2. Owner setup: confirm-password field

**Problem.** The owner-account creation screen has a single password field with `minLength={12}` and
the helper "Use at least 12 characters." There is **no confirm-password field and no strength
feedback.** A silent typo on the only privileged account = locked out of everything.

> **Scope note.** The deeper "there is no password reset" problem is intentionally **not** solved
> here — recovery is tracked separately as item 14 (password recovery story). Do not add a
> no-reset warning to this screen as part of item 2.

**Evidence.** `suite-manager/frontend/src/features/setup/OwnerSetupScreen.tsx` lines ~76–86
*(verified)*. No "forgot password" flow exists in the login screen *(verified: `LoginScreen.tsx`
has no recovery path; `useSetupSession` exposes only create/login/logout)*.

**Why it matters.** A mistyped password is silent and permanent, and it hits the least-technical
users hardest.

**Fix.**
- Add a **Confirm password** field; block submit on mismatch with a plain-language error.
- Consider lightweight strength feedback (length met / not met is enough; don't over-engineer).
- Fix related copy while here (see item overlap): the H1 says "Create your **MOS** owner account"
  before "MOS" is tied to "My Own Suite," and the lead references *"the future app platform"*
  (roadmap language). Spell out "My Own Suite" once; describe what the account does **now**.

**Acceptance.** Submitting with mismatched passwords is blocked with a clear message; no "future/MOS"
jargon in first-visible copy.

**Files.** `suite-manager/frontend/src/features/setup/OwnerSetupScreen.tsx` (+ the setup submit
handler if confirm validation lives outside the component).

---

### 3. Replace the placeholder dashboard with a real first-run experience

**Problem.** The first screen inside Suite Manager after setup is developer scaffolding **and a dead
end** — it declares setup complete but offers no way to install an app; the only path forward is
discovering the hamburger menu.

**Evidence.** `suite-manager/frontend/src/features/app-shell/AppShell.tsx` *(verified)*:
- line ~71: *"Owner setup is complete. App installs, platform settings, and host-agent controls will
  grow from here."*
- lines ~85–87: *"Current milestone" / "Owner onboarding" / "No optional apps are installed by this
  slice."*

"milestone," "slice," and "host-agent controls" are engineering words a Notion/Workspace user won't
parse.

**Why it matters.** This is the product's first impression after the charming website. It reads like
an internal build, and it strands the user with nothing to click.

**Fix.**
- Replace the hero copy with plain language + a primary action, e.g. "You're all set — install your
  first app to get started," button → Apps (`navigate('apps', …)`).
- Drop the "Platform state / Current milestone / slice" card, or replace it with a plain "You haven't
  installed any apps yet" card that links to the catalog.
- Add a small **first-run checklist** on the dashboard: **1. Install an app → 2. Add it to your
  Homepage → 3. Make your first backup**, each linking to the relevant screen. This single addition
  also resolves the "no global getting-started guidance anywhere" gap (there is currently no Help
  link or tour in the nav).

**Acceptance.** A brand-new owner lands on a plain-language dashboard with an obvious next step and a
visible path to their first app; no "slice/milestone/host-agent" copy remains.

**Files.** `suite-manager/frontend/src/features/app-shell/AppShell.tsx` (dashboard default route).
Reuse existing shared UI primitives (`suite-manager/frontend/src/components/`) per `AGENTS.md` — do
not invent one-off cards/buttons.

---

## Tier 2 — Detailed

### 4. Fix the "only you hold the keys" cloud overclaim

**Problem.** `site/src/components/ValuePromise.astro` line ~6 *(verified)*: *"Whether it runs on a
computer at home **or a server you rent**, only you hold the keys."* This is precisely the claim the
cutover review said to avoid for rented servers (`docs/beta-main-cutover-checklist.md`, item #9 + the
"Avoid until…" list: *"'Only you hold the keys' for rented cloud servers."*). The docs' own
`why-your-own-cloud.md` honestly explains that a hosting provider *can* technically read the disk — so
the landing bullet overclaims and contradicts the site's own careful framing.

**Fix.** Scope the claim to what's true in both cases (e.g., "no one mines it, sells it, or locks you
in") and reserve "only you hold the keys" for the own-hardware story, or soften to "you decide who can
touch it." Keep it consistent with `why-your-own-cloud.md`.

**Acceptance.** No absolute "only you hold the keys" claim is attached to the rented-server case.

**Files.** `site/src/components/ValuePromise.astro` (check `Safety.astro` and hero copy for the same
phrasing).

### 5. De-jargon the Backups screen

**Problem.** The screen leads with a red "unencrypted full-secret exports" warning before the user has
done anything, and the empty state instructs users to *"attach and mount a provider block-storage
volume"* with no help link. "mount," "block-storage volume," "writable" are sysadmin terms; a
cloud-server office worker is at a hard dead-end.

**Evidence** *(approx — confirm)*: `suite-manager/frontend/src/features/backups/BackupsScreen.tsx`
warning ~line 363, empty state ~lines 451–454, button-state jargon in `getBackupButtonState` ~lines
169–176.

**Fix.** Soften "mount" → "connect"; add per-environment "How do I attach a drive?" links (own
hardware vs cloud) pointing at the backup/install guides; move the full-secret warning to
**download-time** (it already repeats beside the download action) instead of leading the page with it,
so backups read as protective, not dangerous.

**Acceptance.** A non-technical user reaches an actionable next step (with a help link) instead of an
unexplained "not mounted" wall; the page doesn't open with fear.

**Files.** `suite-manager/frontend/src/features/backups/BackupsScreen.tsx`.

### 6. De-jargon the catalog search + "Posture score"

**Problem.**
- The primary app search placeholder advertises developer behavior: *"Search apps, or paste a GitHub
  repo URL…"* — the first search box every user sees, and the on-ramp to the "Unverified external
  package" flow. *(approx — confirm: `AppsScreen.tsx` ~line 1411.)*
- "Posture score" is a prominent app-detail fact-tile label. "Posture" is security jargon. *(approx —
  confirm: `PrivacyPosture.tsx` ~line 55, used in `AppsScreen.tsx` ~line 806.)*

**Fix.** Change the search prompt to "Search by name or what you want to do," and move
paste-a-repository behind an "Advanced: add from a repository" affordance. Relabel "Posture score" →
"Privacy rating" (or just "Privacy").

**Acceptance.** The default search prompt contains no developer terms; the privacy tile label reads
for a non-technical user.

**Files.** `suite-manager/frontend/src/features/apps/AppsScreen.tsx`,
`suite-manager/frontend/src/features/apps/PrivacyPosture.tsx`.

### 7. Reorder the landing page

**Problem.** `site/src/pages/index.astro` *(verified)* order is
`Hero → ValuePromise → HowItWorks → InstallPaths → AppCatalog → WhoItsFor → Tour → Safety → …`.
`InstallPaths` (with `curl … | sudo bash`, "USB installer," "Erases the target disk") is **4th**, so
non-technical visitors meet the most intimidating content before they've seen the app catalog or the
"as easy as the phone in your pocket" tour.

**Fix.** Move `InstallPaths` to sit after `AppCatalog`/`Tour` (build desire first, then show the
path). Same content, better emotional sequence.

**Acceptance.** Scrolling the landing page introduces apps and the friendly tour before the raw
install command / disk-erasing installer.

**Files.** `site/src/pages/index.astro`.

### 8. Demote the Customize YAML editor

**Problem.** `suite-manager/frontend/src/features/customize/CustomizeScreen.tsx` surfaces raw
`bookmarks.yaml` / `widgets.yaml` / `services.template.yaml` editing as the primary UI, with the
friendly "Add to Homepage" dialog secondary. For non-technical testers this screen is a nonstarter.

**Fix.** Make the guided "Add to Homepage" dialog (`AddHomepageItemDialog.tsx`) the default surface;
tuck the YAML file editor behind an "Advanced" disclosure (per `AGENTS.md`: keep low-level
technical/diagnostic surfaces behind an **Advanced details** disclosure).

**Acceptance.** A non-technical user can add a link/service without seeing YAML; power users can still
reach the file editor under "Advanced."

**Files.** `suite-manager/frontend/src/features/customize/CustomizeScreen.tsx` (+ dialog).

---

## Tier 3 — Detailed (batch)

### 9. Reconcile cost framing
`getting-started.mdx` says "From roughly $20–25/month"; the FAQ (`site/src/components/Faq.astro`) and
`InstallPaths.astro` say "the price of a couple of coffees a month." $24/mo isn't coffee money for
most readers — pick one honest frame and use it everywhere. *(site, Tiny.)*

### 10. Humanize the secure-transport failure message
`suite-manager/frontend/src/features/setup/useSetupSession.ts` ~line 34 *(approx — confirm)*: the
failure copy is pure sysadmin (*"Check that your VPS provider allows inbound TCP traffic on ports 80
and 443…"*). A non-technical user hitting this is stuck. Add a plain-language explanation and a "What
does this mean?" doc link; name common providers if practical. *(frontend, Small.)*

### 11. Route the primary CTA to the guided flow
Hero + header "Get started" both jump to `#install` (the raw command). Point the primary CTA at the
guided getting-started flow and keep the raw command as the reward once a path is chosen — so the
first concrete thing a non-dev sees isn't `sudo bash`. `site/src/components/Hero.astro`,
`SiteHeader.astro`, `FooterCta.astro`. *(site, Tiny.)*

### 12. DigitalOcean guide render nit
`digitalocean.mdx` *(verified)*: missing blank line between the "Backup destination" section and
"## Good to know" (~line 61→62). *(docs, Tiny.)*

---

## Cross-cutting principle (apply throughout)

The product already has the right voice in places — install progress copy ("Adding a clean shortcut
to your private Homepage," "The app is ready to open"), the uninstall data-loss confirmation, "Stop
(keeps data)," and the plain-language "Requested access" permission labels are all well-judged. The
setup, dashboard, backups, and customize screens simply **haven't caught up to that voice yet**. When
editing any user-facing string, write it the way those good examples do: plain language, explain the
consequence, give the next action. Preserve technical accuracy — move diagnostics behind **Advanced
details**, don't delete them.

## Do NOT regress
- Beta honesty surfaces (the dismissible beta snackbar, "About this beta" dialog including the
  AI-assistance disclosure) are trust-building — keep them.
- Per-app privacy posture, "Try [app]" demo-deploy links, and "apps that work together" are
  differentiators — keep them.
- The `why-your-own-cloud.md` safe-deposit-box framing is the strongest trust copy on the site —
  don't flatten it; align other copy *to* it (see item 4).

## When the batch is done
- Ensure `CHANGELOG.md` `## [Unreleased]` reflects the user-visible outcomes (few broad bullets).
- Run `npm test`, `npm run typecheck`, `npm run build:client`, and confirm `site/` builds clean.
- Ask the owner to run any relevant E2E/onboarding smoke checks (human-run per `AGENTS.md`).
- Remove this document or replace it with a pointer to the GitHub issues created for items 13–14.
