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
`backup-restore-reliability-plan.md`, and the app-package refactor plan. Current release: 0.18.0.

---

## Now — Beta hardening

The window before and during private tester recruitment. Recovery leads, because a privacy-first
platform whose backups are unencrypted full-secret exports is the sharpest dissonance in the product.

### A. Recovery an owner can trust without an asterisk

**Gate:** the storage engine is chosen on measured evidence, an owner sets a recovery key once,
backups run on a schedule with retention to an attached disk or an S3-compatible bucket, and no
restore screen shows a raw 502 or an internal path.

The restore contract itself is drill-verified and is not in question (`docs/decisions.md`,
2026-07-30). What is missing is encryption, scheduling, retention, and an off-site destination — and
the tar-bundle storage format cannot reach them, because whole-copy archives make daily schedules and
cloud uploads arithmetically impractical. Every item below assumes the storage layer *inside* the
existing engine becomes a third-party content-addressed repository, and that the orchestration around
it — journal, rescue generation, absence reconciliation, ownership classification, verification gate
— does not change.

- **A1 — Dual spike, then pick the storage engine.** *Decision node: A2–A5 are blocked on it.* Kopia
  and restic are close enough that this has to be measured rather than argued. Build both behind the
  existing injected system adapter and measure the same four things on real MOS data: peak memory
  backing up an Immich-scale volume on a 4 GB box, restore into a freshly created Docker volume with
  uid/gid and modes intact, refusal behaviour on a deliberately corrupted repository, and
  replacement-machine recovery with no downloadable bundle in the picture. The standing preference is
  Kopia — `repository sync-to` is the disk-plus-cloud model built in, KopiaUI is an escape hatch a
  non-technical owner can actually use, and Velero deprecated restic in its favour after running both
  at production scale. The counterweight is restic's settled repository format and `rustic`, a second
  independent implementation of it, which is a stronger answer to **B3** than any promise MOS can
  make. Memory is the axis that can overturn the preference. Record the outcome in
  `docs/decisions.md`. *(Medium — owner-run measurement; blocks the rest of this theme)*
- **A2 — Adopt the chosen engine, and re-earn the guarantee.** Three of the backup agent's
  twenty-two adapter methods change — `archiveTree`, `extractArchive`, `assertArchiveReadable` —
  along with the manifest fields that exist only to record per-archive digests. Everything the July
  drills proved stays. The real cost is not the integration: the storage half of the evidence behind
  a `verified` restore guarantee stops applying, so the corruption, insufficient-space,
  disconnected-destination and power-loss drills all re-run. Both mount-liveness refusals must
  survive, at job start and at completion. The downloadable single-file bundle does not survive —
  moving a copy means moving the repository — so the upload path and the bundle list are redesigned
  around restore points rather than files. *(Large — flagship)*
- **A3 — Recovery-key lifecycle.** The engine supplies the cryptography; this is everything around
  it, and it is the half that does not come free. Generate a strong key, present it once, offer an
  export file, decide where the operational copy lives so unattended scheduled backups can run, and
  design what an owner sees when the key is gone. Retire the "backups are not encrypted" warning in
  the backup guide only when this is real, and say plainly that a key held on the server protects a
  stolen drive or a breached bucket, not a compromised server. *(Medium)*
- **A4 — Scheduled and pre-update backups, retention, last-known-good protection.** Manual-only
  backup means the newest thing an owner has is whenever they last remembered. MOS owns the
  scheduling whichever engine wins: neither engine's built-in scheduler runs without a daemon MOS
  will not run, and a bare snapshot would skip the stop-and-quiesce sequence entirely — so this is a
  systemd timer feeding the existing job pipeline. Retention comes from the engine. A checkpoint
  before every update is on by default and switchable off; it needs a "skipped — destination not
  connected" outcome rather than a failure, and it has to be precise about scope, because a platform
  update and a per-app update transaction are different things. *(Medium)*
- **A5 — Two destinations: an attached disk, and an S3-compatible bucket.** Absorbs the former
  **D1**: object storage stops being a new subsystem once the engine speaks it natively. Exactly two,
  because every advertised destination needs backup *and* restore drills before it is offered. Needs
  credential storage, destination UI, and the remote equivalent of the mount-liveness refusal. The
  server's own system disk may be a staging or replication source but is never offered as the only
  destination — that shape is what once wrote 13 GiB to the root disk and reported success. See
  **OQ1** for the remaining choice between one replicated repository and independent repositories per
  destination. *(Medium)*
- **A6 — Restore-experience follow-ups from the July drills.** Serve a static "MOS is restoring"
  page from Caddy instead of a raw 502 during the control-plane outage; map journal phase IDs
  (`reconciling-apps`, …) to plain language in the interrupted-restore notice; say "the uploaded
  file" instead of leaking the internal temp filename; offer Mount for whole-disk filesystems, not
  only partitions. *(Small, bundled)*
- **A7 — Decide a cleanup story for anonymous Docker volumes.** Unlabeled, hash-named volumes left
  behind by removed app containers are outside MOS ownership by design, so restore correctly refuses
  to claim them — and nothing else ever removes them either. *(Small — needs a decision first)*

### B. Trust claims that survive DevTools

**Gate:** every visible privacy grade has a human behind it, no third-party cookie reaches an install
domain, and "what if myownsuite.org disappears" has a published answer.

- **B1 — Sign the rest of the baseline, and make AI the change detector.** The first-entry half is
  established: `skills/human-privacy-review` is the written procedure, a review records
  `humanReviewed` and a named reviewer, and the packages that entered the catalog most recently were
  signed before they shipped. Two things are unfinished. Half the catalog — ONLYOFFICE, Seafile,
  Stirling PDF and Vaultwarden — still publishes assessments no human has signed, which the site
  discloses honestly and which is still a discoverable gotcha on the most differentiated feature in
  the product; two of the four are reruns rather than signatures, because a capture taken since
  contradicts a published claim in each. And the change detector does not exist: an app update
  re-authors the whole assessment from scratch, when it should be reviewed as a **diff against the
  last signed review** — the work AI is genuinely good at, the part that does not scale by hand, and
  the only thing standing between an upstream policy change and a published grade that moves with no
  human in the loop. Anything the diff surfaces goes back to a human before the grade moves. Needs
  `assess-app-privacy` split into first-entry and update-diff modes, and a provenance field recording
  which one ran. *(Medium)*
- **B2 — Get the MOS zone onto the Public Suffix List.** `#192`. The zone is operated now and the
  contract is in `docs/decisions.md`; what is left is the listing, and it is the long pole. It began
  as a cookie-isolation fix: Google Analytics cookies land on install domains because sslip.io is not
  on the PSL — inert, but it contradicts the promise for anyone who opens DevTools. It is now
  load-bearing for the whole own-hardware path, because without the listing one install's suite can
  set cookies another install's suite reads, and Let's Encrypt's fifty-certificates-per-registered-
  domain limit keeps **H8** on plain HTTP. The entry is a pull request against `publicsuffix/list`
  that then waits on browser release cycles, so the lead time is months and it has to start early —
  and the PSL guidelines decline beta-stage projects, so the submission needs the project to look
  like something first. The remaining non-PSL work is disclosure: MOS receives the queries, and the
  no-log commitment belongs in the privacy policy and in **B3** rather than being discovered.
  *(Medium — the submission is the part that has to start early)*
- **B3 — Sovereignty guarantee document.** Near-zero code: state what is already structurally true —
  no account, no license server, AGPL, catalog verifiable offline, per-install snapshots — plus an
  explicit "if this project vanishes, your suite keeps working and anyone can mirror it." Answers
  both the Cloudron-history question and the revenue-model question that launch will produce.
  *(Small)*
- **B4 — Let owners choose privacy-relevant app settings at install time.** MOS pins app
  configuration with a baked-in config file, which is what makes a hardened default possible and also
  freezes that setting for the owner. Immich is the worked example: the signed review found its map
  is a genuinely valuable feature that reaches an external tile service, and because MOS ships it on
  through `IMMICH_CONFIG_FILE`, Immich rejects every system-configuration change, so the owner has no
  way to turn it off. That is what makes its posture `external-dependency` rather than
  `owner-disableable`, and the distinction is now honest rather than an artefact of the vocabulary.
  What remains is that MOS's own pinning is what removed the control: an app the owner could have
  configured is presented as one they cannot. Surfacing a small set of package-declared,
  privacy-relevant settings during install would give the choice back. Needs a manifest field for
  owner-visible settings, install-flow UI built from the shared primitives, and a review contract
  that can express a posture conditional on a choice rather than one fixed at packaging time.
  *(Medium)*

### C. What a tester hits in the first hour

**Gate:** a friend-tester can predict the cost and the install time, knows where they land after
setup, never waits at a screen that looks hung, and is never shown a technical surface they cannot
act on.

- **C1 — Record and embed the install walkthrough video.** Provider web console → one command → the
  printed Finish-setup link → owner account → first app. Three site spots currently promise it as
  "on the way". Hosting must respect the page's own privacy claim — self-hosted file or a no-cookie
  embed, not a plain YouTube iframe. *(Owner-run)*
- **C6 — Record the own-hardware install walkthrough.** The second video: download → Etcher → boot →
  choose 1 and confirm → save the server login → owner account. Unblocked — the disk image is the flow we intend
  to keep — but it needs a release first, because the walkthrough films a published download and not a
  branch. *(Owner-run)*
- **C2 — "What it costs" docs page.** Apps running × VPS size × monthly range, provider-neutral, with
  an own-hardware electricity row and an honest note that the stated 2 vCPU / 4 GB minimum plausibly
  cannot run the advertised Seafile + ONLYOFFICE pair. Also rewrites getting-started's overspecific
  "roughly the price of the subscriptions you're replacing" line. Must cover **disk capacity**, not
  only CPU and RAM: nothing in the docs currently says how much storage a plan includes, block storage
  is billed per GB at every provider, and app data cannot be moved off the root disk today — so a
  reader arriving from Google Photos has no way to predict either the size or the bill. This is where
  own hardware is the honest answer for large libraries. *(Small)*
- **C3 — App-install duration expectations.** `#235`. First installs of heavy apps take up to ~10
  minutes and nothing says so; a user watching "Starting app" has no reason to believe it isn't hung.
  Install stepper copy, `guides/apps.md`, first-start. *(Small)*
- **C4 — Returning-owner welcome screen.** First-run state is handled; the returning-owner state has
  no design — quicklinks, apps running, last-backup age, updates available. The post-setup redirect
  question inside this item is settled: accepting the terms lands the owner on Suite Manager, because
  first run is the only moment with a server login to hand over, and ordinary sign-ins go on to the
  Homepage dashboard as before. *(Medium)*

### H. Install media people can just flash

**Gate:** downloading and flashing the published image is the whole own-hardware path, a stranger can
boot it on their own machine without the project having guessed wrong about their disk, and they can
open their suite — and the apps they install into it — from a phone or a laptop without first
configuring DNS.

Promoted from **L7** and from the standing "own hardware is for technical users" position, which this
theme retires.

**The download is now a prebuilt disk image, and the ISO installer is retired as a download** — the
2026-08-16 decision records the contract. What is left in this theme is the part an image cannot fix
on its own: machines that install but will not boot, and reaching the suite once it is running.

- **H10 — The installer writes no boot entry for the disk it just wrote.** `mos-image-finalize` uses
  `grub-install --removable`, which is right for a stick and leaves a fixed disk depending on firmware
  that tries `EFI/BOOT/BOOTX64.EFI` on its own. The ones that do not say *no bootable drive* with the
  stick out and boot normally with it in — which reads as a failed install and is what the multi-disk
  picker now makes more likely, since the firmware has more disks to guess between. `mos-self-install`
  should add an `efibootmgr` entry for the disk it wrote. *(Small)*
- **H9 — Re-render app routes when the machine's address changes.** The Easy Door name encodes the LAN
  IP. Suite Manager survives a DHCP move because its site block matches any private address, but every
  installed app's route names one exact host and is only re-rendered when that app is next applied — so
  the suite comes back and the apps do not. A reboot is not the trigger: a lease changes on a running
  machine. Needs address-change detection plus a re-apply of the generated routes, and it is what
  turns the DHCP reservation from a required install step back into advice. *(Medium)*
- **H7 — Tell the owner which door actually works on the device in their hand.** The console banner
  now states both doors and the dashboard works through either, and the contract for both is in
  `docs/decisions.md` (2026-08-16). What is left is the case the banner cannot cover: rebinding
  protection blocks the MOS-zone door on real networks, and whether it works varies *per device on
  one network*, because Private Relay and Private DNS route lookups past the router. A console banner
  cannot probe anything and the server cannot decide once for every device, so the probe has to run
  in the owner's browser and the onboarding screen has to react to what it finds. The banner's
  standing advice — no answer on the second address means your router refuses names pointing into
  your own network, use the first — is the fallback this replaces, not a stopgap to remove. *(Small)*
- **H8 — Trusted HTTPS with no domain to buy.** A self-hosted suite serves plain HTTP, so the owner
  password is first set over an unencrypted connection and secure-origin apps do not work at all.
  Promoted out of the alpha gate: it is not hardening, it is the only entry door that half the
  audience has. **The address half has landed** — the box answers on
  `home.<lan-ip-with-dashes>.local.myownsuite.org` and serves every installed app under the same
  base, `http://home.mos.home` stays the recovery door, and applying a real domain closes it; the
  contract is in `docs/decisions.md`. It left two things behind: rebinding protection, which belongs
  to **H7**, and address instability, which is **H9**.

  **The HTTPS half is a separate and larger problem than it looked.** A LAN box is not publicly
  reachable, so HTTP-01 and TLS-ALPN-01 are out and DNS-01 is the only challenge left — but DNS-01
  means writing a `_acme-challenge` TXT record, and the MOS zone is deliberately stateless with no
  writable path and no zone-editing credential anywhere. So certificates need something that stores
  per-install challenge state: either the registry declined below, or an `acme-dns`-style responder
  whose entire scope is holding TXT challenges under per-install credentials, which is the narrower
  and more defensible shape. That is on top of the PSL entry in **B2**, not instead of it. The
  existing Cloudflare flow stays for owners bringing their own domain. *(Large)*

A flashable image that installs an OS and then runs a root shell script is the highest-trust artifact
the project ships, which is what makes **E3** load-bearing rather than aspirational.

### I. Knowing why something broke

**Gate:** the one file an owner hands over contains the reason for *every* failure class, including a
privileged command that failed.

Most of this theme has landed and its contracts are in `docs/decisions.md` (2026-09-01, both entries):
the logging format, the persisted app-operation failure, container log caps and journald bounds, the
root diagnostics agent, and the owner-facing export in **Settings → Get help with a problem**. What is
left is the one hole that stops the bundle being complete.

- **I2 — Capture failed-command output in the host agents.** `#247`. The agents still run privileged
  commands with `stdio: 'ignore'`, so a package's failed `docker build` discards its reason and the
  bundle carries the failure without the cause. This **amends a stated security property** —
  `system-agents/README.md` promises the HTTPS agent's logs never include command output — so it is
  argued before it is built and recorded in `docs/decisions.md` after. The real hazard is not stderr
  but the command line: app containers are started with materialized secrets on the argv, so any error
  path that echoes what it tried to run leaks every app secret at once. Capture output, never
  arguments. The diagnostics agent already sets the precedent for the safe half of this.
  *(Medium — posture change)*

### J. Configuration an owner can reach

**Gate:** an owner can change an installed app's configuration from Suite Manager — both the settings
MOS asked for at install and the ones it never knew existed — without SSH, and without a wrong value
leaving the app dead.

Config is captured once, at install, and never again. There is no reconfigure path of any kind, so
correcting a mistyped time zone means reinstalling, and anything the package did not think to ask for
is unreachable except by editing generated compose over SSH. The wall a tester actually hits is
Paperless and a Microsoft mailbox: Outlook consumer IMAP is OAuth-only, which needs two upstream
environment variables MOS has no reason to know about.

- **J1 — Custom environment variables per installed app.** An app-agnostic escape hatch, behind
  technical controls in a per-app settings dialog, never in the install flow — the values cannot exist
  before the app has a URL. Owner-set names are rejected on collision with MOS-managed ones rather
  than silently losing, and a change that fails its health probe rolls back to the previous
  environment automatically. Recurring variables graduate into package setup fields; the hatch is for
  what MOS does not yet know. *(Medium)*
- **J2 — Re-editable setup fields after install.** The same dialog, holding what the package asked for
  at install so it can be corrected without a reinstall. Needs the secret rows to round-trip without
  being re-entered, which is the reason it is not folded into **J1**. *(Medium)*

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
  state where owners already look for updates. The published image raises this from small to
  load-bearing: it is frozen at release time, so someone flashing a months-old download starts behind
  on day one. *(Small)*
- **AL2 — Full-disk encryption for own-hardware installs.** The installer uses a plain disk layout, so
  the "safe in your own house" claim currently survives everything except someone carrying the safe
  out of the house. Needs a decision on the unlock model for a headless machine — passphrase at boot,
  TPM-backed, or network-bound — before it is buildable. The published image narrows the options: it
  can carry no key material, so whatever unlocks the disk has to be derived or entered on the machine.
  *(Large — needs a decision first)*
- **AL3 — Sign-in hardening either side of the second factor.** Raise the owner password hashing cost
  to current guidance, and persist the login throttle so restarting the service does not reset an
  attacker's budget. Both are small and independent of the MFA question in **E5**, which is the other
  half of this gate. *(Small)*
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
  and accepting it. The published image supplies part of the answer for own hardware: a per-release
  image is an installer pinned to a known version, which is exactly what the bundle's instruction asks
  for. What is missing is reaching an *older* release's image once its object has been pruned. The
  storage-engine change (**A2**) adds a second version axis: an older MOS carries an older engine
  binary, so the repository format is pinned per release and never auto-upgraded.
  *(Medium — solution not yet determined)*

### AL-C — Storage

- **AL8 — Per-app volume placement.** App data lives on whichever disk the container runtime uses, so
  the system disk is the ceiling and attaching a larger volume does nothing for it. Documented as a
  manual pre-install mount for now (`cloud-server.mdx`), which does not help an existing install and
  cannot vary per app. The durable answer is MOS choosing where each app's volumes live. *(Large)*

### Carried in — already tracked above, and alpha gates rather than 1.0 wishes

**A2** the storage-engine swap and encrypted repositories · **A4** scheduled backups · **A5** an
off-site destination · **B1** human sign-off on privacy reviews · **E3** signed release and installer
artifacts · **E4** owner-facing security events · **E5** passkeys and the MFA shape · **F1** runtime
hardening of app containers · **H8** trusted HTTPS on own hardware. Alpha is where these stop being
roadmap and become the bar.

---

## Next — Toward 1.0

### D. Recovery breadth

**Gate:** recovery no longer requires a matching MOS version, an owner reading a journal, or a
destination MOS had to be taught by hand.

- **D1 — Further destinations beyond the first two.** B2, Azure, GCS and SFTP are all backends the
  chosen engine already speaks, so each costs credential capture, UI, and its own pair of drills
  rather than architecture. Demand-driven: add one when testers ask for it, not to lengthen a list.
  *(Small, each)*
- **D2 — Restore compatibility migrations and a bare-metal recovery runbook.** Restore currently
  requires a compatible installed MOS and reuses the software already on the box; recreating the
  recorded version is not implemented. *(Medium)*
- **D3 — Automatic rollback after a failed restore.** Today a safe failure leaves a journal, a rescue
  generation, and a blocked agent awaiting typed acknowledgment — correct, but manual by design until
  interruption behaviour was proven. It now is. A repository-backed rescue point is cheap enough to
  keep more than one of, which changes what rollback can offer. *(Medium)*
- **D4 — Periodic verification restores.** A backup nobody has restored is a hypothesis. The engine
  supplies the primitive — a verify pass that downloads and decrypts a configurable share of the
  repository — so what remains is scheduling it and reporting the result in owner language.
  *(Small)*
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
  release and the pipe-to-shell installer that delivers everything are not. **The published image makes
  this a gate rather than a nice-to-have** — a downloadable image that installs an OS and runs a root
  shell script is the highest-trust artifact MOS ships, and since `v0.16.0` it is served from object
  storage rather than from the repository people trust. Checksums now ship on the release page; what is
  missing is a signature and build provenance from the release pipeline. *(Medium)*
- **E4 — Owner-facing security event read surface.** `security_events` durably records throttled
  sign-ins, refused packages, download-bound trips, and failed catalog refreshes — with no route and
  no UI, so nothing is ever shown to the owner. A failing catalog refresh is the quiet one: the cache
  keeps serving while MOS stops learning which installed packages have advisories. *(Small)*
- **E5 — Passkeys, and decide the MFA shape.** `#238`, after `#237`. Research
  passkey-as-second-factor vs passkey-as-sole-credential and bring a recommendation before
  building. The deciding constraint is that the relying-party ID is the Home host, which changes
  when an owner applies HTTPS and will change again under **B2**. *(Medium)*

### F. Runtime hardening

**Gate:** a compromised app is bounded by the runtime, not only by the install gate.

- **F1 — Harden catalog app runtimes.** No `--memory`, `--cpus`, `--pids-limit`, `--read-only`,
  `--cap-drop`, `--security-opt`, or `--user` is set anywhere today, and single-service apps sit on
  the default bridge. MOS enforces strictly at the gate and not at all at runtime; doing both is
  achievable and unmatched among comparable platforms. *(Large)*

### G. Ops hygiene

**Gate:** the claim-drift class the July 2026 audit found cannot recur silently.

- **G1 — Automated stale-wording checks for active documentation.** `#224`. The audit's core finding
  was that claims outlived the facts and lived in more places than the facts did. *(Small)*
- **G2 — Site link, accessibility, and clean-build checks in CI.** `#225`. Clean-build landed with the
  deployment cutover; links and a11y did not. *(Small)*

---

## Later — Bets and deferred

- **L1 — Restore the shared SMTP relay.** A MOS1 capability (v0.9.0) absent in MOS2; apps half-work
  without outbound mail — Vaultwarden hints at it, Seafile notifications are off. Relay presets only,
  explicitly **not** a mail server. *(Medium)*
- **L3 — Communicate capacity in-product.** See **OQ2**. Folds in resource estimation/preflight for
  Immich, Seafile, and ONLYOFFICE. *(Medium)*
- **L4 — One proven local VM/filesystem snapshot integration.** Fast same-machine rollback; never a
  replacement for portable recovery. *(Medium)*
- **L5 — Partial restore.** Deliberately excluded from the first architecture. *(Large)*
- **L6 — Wider version, hardware, and architecture compatibility.** Packages may now declare
  `architectures` and incompatible hosts are refused at install; arm64 catalog support is the actual
  work. *(Large)*
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

**OQ1 — One replicated repository, or independent repositories per destination.** The cloud-backup
question that used to sit here is answered by **A5**: the engine speaks S3, so object storage becomes
a destination rather than a subsystem and "attach, format and mount a block-storage volume" stops
being the cloud instruction. What is left is a real fork. Replication — Kopia's `repository sync-to`,
or an rsync of a restic repository — is incremental and cheap, but the second copy is a *mirror*: it
inherits the primary's snapshot set and any corruption in it, and it does not propagate deletions
unless told to, so retention on the two copies silently diverges. Independent repositories per
destination give genuinely isolated copies at roughly double the backup work, and need the offline
drive attached whenever the job runs. Provider snapshots stay outside MOS either way, useful as a
supplementary layer with the consistency caveat the guide already carries.

**OQ2 — Communicating per-app resource needs in-product.** **C2** answers sizing *before* install.
The per-app half is now decided and built: packages declare resting and peak memory/CPU per service
(`resources.services.<id>.requires`), and the app's Resources view states them. What remains is the
suite-level half — an owner with a 4 GB server still adds the figures up themselves. A capacity view
that compares declared totals against the machine, and eventually against measured use, is the
candidate; it is only worth building once most of the catalog declares figures, since a total that
silently omits undeclared apps is worse than no total. Catalog-card RAM badges were considered and
left out: the card is the scanning surface and already carries category, status and summary.

---

## Decided — do not re-raise

Owner decisions. Future agents and reviews should not resurface these.

- **Password recovery / owner account lifecycle** — post-beta; not part of early testing.
- **Reaching apps by path or by port** (`server/seafile`, `server:8001`) — declined. Subdomains are
  separate browser origins, so collapsing apps onto one makes any single app's XSS everyone's problem,
  and it breaks password-manager matching for a large refactor and an uglier result. MOS carries many
  separate web apps, which is exactly what single-app self-hosted projects do not have to solve.
- **mDNS `.local` as the way in** — declined as the primary answer. Android does not resolve `.local`
  in the browser, which loses the device people open a photo suite on, and `.local` can never carry a
  publicly trusted certificate. Note for anyone tempted to reopen it: the absence of mDNS wildcards is
  *not* the reason, because MOS owns the app lifecycle and could publish a record per app on install.
- **MOS shipping its own LAN DNS resolver** — declined. It adds nothing for owners already running a
  resolver, and buying the router-only case costs an always-on service, a `systemd-resolved` port
  conflict, and a failure mode where the box going down takes the household's DNS with it. **H8**
  reaches the same owners without any of that.
- **A bare-IP catch-all as the answer to reachability** — declined as a solution, though it may still
  ship as a convenience. It fixes first contact and nothing after it: `seafile.192.168.123.45` cannot
  exist, so the first app an owner installs puts them back where they started.
- **A stateful DNS registry — a Worker, the Cloudflare API, and a record per install** — declined for
  now. It is free and gives stable names that survive a DHCP change, but it is security-sensitive code
  holding a credential that can edit a DNS zone, against a stateless nameserver with no code to audit
  and no credential to lose. It stays the documented upgrade path if name instability annoys real
  testers, and **H8**'s certificate half may force a narrow version of it regardless.
- **Hosting authoritative DNS on Railway, Cloudflare Workers, or any PaaS** — impossible, verified,
  not a budget question. Recursive resolvers query authoritative servers over plain UDP/53 and need a
  static inbound address; DNS-over-HTTPS is a stub-to-resolver protocol and does not substitute. This
  is why the feature costs a Droplet. DigitalOcean over Hetzner because it is one existing bill and DO
  Reserved IPs are free while attached, so a rebuilt box keeps the address the NS record points at.
- **Railway "try it" demos stay low-key** — intentional, for search and for people who find them. Do
  not promote them on the landing page.
- **No public roadmap page** for early testers.
- **"One button" backup wording stays** — close enough to the real experience.
- **Do not build a bespoke backup repository format.** Encryption, deduplication, chunking,
  retention and repository maintenance are delegated to a proven third-party engine (**A1**). A
  home-grown implementation of this class can look correct for years and fail on the one day it is
  needed, and an owner recovering without MOS is better served by a widely mirrored format with its
  own client than by one only MOS can read.
- ~~**The own-hardware path is for technical users.**~~ **Reversed.** It was accepted as a hard truth
  because polishing it looked expensive; the prebuilt image turns out to be the cheap fix rather than
  the later bet, because the ISO builder already exists and building it once removes the Node and
  Docker prerequisites entirely. Now theme **H**.
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
