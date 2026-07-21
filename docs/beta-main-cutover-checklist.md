# MOS Beta Main-Cutover Release Checklist

This temporary, release-specific document tracks the MOS beta main cutover and its separate public announcement. It records the July 2026 helicopter review and should be removed or replaced with release notes after this release is complete. A checked item means the repository evidence has been updated and the relevant validation has passed; wording changes alone do not close an implementation or security item.

The two decisions are intentionally separate:

- **Main cutover:** MOS becomes the repository default, clearly labeled beta.
- **Public launch:** the MOS site and installation paths are promoted to new users.

### At-a-glance gate

#### Blockers before main cutover

- [x] Managed updates apply all repo-owned app runtime changes before reporting success, or managed apply is disabled and described as experimental — resolved by the snapshot contract: platform updates apply all platform-owned code and truthfully state that installed apps stay on their package snapshots; app changes apply only through the per-app update transaction (see item 1).
- [x] The Stable update track can actually apply tagged releases, or its apply controls and claims are removed until supported — Stable is now visibly read-only: the Updates screen disables selecting it, refuses apply with a clear message, and the backend rejects stable-track start before the agent is asked (see item 2).
- [x] Public cloud first-owner setup and subsequent owner authentication no longer rely on exposed plain HTTP, or cloud installation is explicitly removed from the supported beta paths.
- [x] The landing-page one-line installer is implemented, tested, and safely delivered, or the unsupported command is removed.

#### High priority before public announcement

- [x] Remove obsolete USB-installer owner fields and make browser owner creation the only owner bootstrap path.
- [x] Make backup integrity and replacement-machine restore claims match verified behavior.
- [x] Build the MOS `site/` from a clean install in required CI before deployment cutover — the `MOS Site` CI job runs `npm ci` + `astro build`; its first run exposed integrity hashes in `site/package-lock.json` corrupted by the generation-label rename, now fixed with registry-verified values. The deployment cutover itself is implemented: `.github/workflows/deploy-site.yml` builds `site/` and deploys to Cloudflare Pages from `main` and `staging` only, and the MOS1 site is retired from CI and deployment (see item 7).
- [x] Publish a real, tested cloud HTTPS procedure or clearly classify cloud TLS as operator-owned and advanced.

#### Beta truthfulness and security

- [x] Remove the temporary generation label from MOS-owned filenames, identifiers, runtime paths, configuration, and active documentation while retaining genuine upstream API and dependency versions.
- [x] Narrow absolute privacy claims to behavior MOS can actually guarantee.
- [x] State clearly which backup destinations work on own hardware and cloud servers.
- [x] Add login throttling/progressive delay for an internet-reachable control plane.
- [x] Keep the unencrypted-backup warning prominent and avoid suggesting casual storage of downloaded bundles.
- [x] Remove stale scaffold/MOS1 wording from active MOS documentation.
- [x] Condense `CHANGELOG.md` into release-shaped MOS outcomes and explicit known limitations.

#### Required validation before approval

- [x] `npm run release:check` — passing after the owner re-signed the catalog on July 21, 2026; catalog and advisory signatures verify against the committed public key
- [x] `npm test` — full suite green on July 21, 2026 (399 tests)
- [x] `npm run typecheck`
- [x] `npm run build:client`
- [x] Clean MOS `site/` install and build in CI — the `MOS Site` job runs `npm ci` + `astro build` from `site/` in `.github/workflows/ci.yml`; its first GitHub run caught real corruption (rename-damaged lockfile hashes, since fixed), and all CI jobs including `MOS Site` passed on GitHub on July 21, 2026, and the job is a required check in the `main` branch protection ruleset
- [x] Installer contract/render checks
- [x] Human-run Hyper-V full-platform E2E after blocker fixes — owner-confirmed on July 18, 2026, including the app catalog, external-package installation, and the broader platform E2E flow
- [x] Real backup/restore drill with representative multi-service and large-data apps — owner-run Hyper-V drills July 20-21, 2026: multi-service (Stirling, Seafile/MySQL, Immich/Postgres, Radicale) restores in both directions, ~6 GiB workload, replacement-VM recovery via uploaded bundle, corruption/version/disk/disconnected-destination refusals, and mid-restore power-loss interruption with journaled recovery; evidence recorded in `docs/backup-restore-reliability-plan.md`
- [x] Explicitly approved DigitalOcean validation if cloud install remains a supported launch path
- [x] Branch protection requires PRs and passing CI for `main` — the "Protect main" ruleset requires pull requests and the current `MOS Workspace`, `MOS Site`, and `Shell Scripts Lint` checks (stale MOS1-era check names removed), plus deletion/force-push restrictions; updated by the owner on July 21, 2026
- [ ] Release metadata, changelog, tag, and release notes agree

### Detailed findings and acceptance criteria

#### 1. Managed updates must fully apply repo-owned app code — completed via the snapshot contract, retain as a regression check

- **Severity:** Blocker
- **Area:** Updates and release architecture
- **Original evidence:** `AGENTS.md` required managed updates to apply all repo-owned code including app containers. `system-agents/update/lib.cjs` reported `manual-reapply-after-core-update`, and `system-agents/README.md` said changed package Dockerfiles or manifests may require owners to reapply or restart apps after a core update.
- **Resolution evidence:** The contradiction was resolved by making app decoupling the explicit contract rather than a partially applied state. Installed apps run from validated package snapshots and are deliberately outside a platform update's scope; app changes apply only through the per-app update transaction (staging, build, health-gated activation, rollback/recovery), which is what actually rebuilds containers from changed package files. `system-agents/update/lib.cjs` no longer emits a manual-reapply warning and logs that installed app runtimes remain bound to their snapshots; `system-agents/README.md`, the public updates guide, and `docs/decisions.md` describe the same scope; `AGENTS.md` rule 7 now states the platform/app split, and the Updates screen states at the action point that apps stay on their snapshots and update separately from Apps.
- **Regression check:** A platform update must never claim to have updated installed apps, and app rebuilds from changed package files must keep flowing through the per-app update transaction (catalog digest/version comparison), never through a silent core-update rebuild.
- **Acceptance:** A platform update reports only platform-owned scope truthfully; a changed app package surfaces as an app update in Apps and applies through the transactional pipeline.

#### 2. Stable update track is advertised but cannot apply — completed as read-only until stable apply ships, retain as a regression check

- **Severity:** Blocker
- **Area:** Updates and releases
- **Original evidence:** The Updates guide and UI presented Stable releases as a selectable track. `system-agents/update/lib.cjs` rejects apply unless the selected track is `branch`. `RELEASING.md` also notes that MOS stable release-track metadata is not complete.
- **Resolution evidence:** Stable is now visibly read-only everywhere it appears. The Updates screen disables the Stable option ("not yet available"), shows a warning notice on installs already parked on Stable, disables the update button with "Stable apply not yet available", and the track helper text says managed updates apply from the Main and Staging branch tracks until the first tagged release ships (after the main cutover, the branch track offers Main — the default for fresh installs — and Staging). `UpdateService.start` refuses stable-track apply with a clear 409 before the update agent is ever asked (covered by a focused test in `suite-manager/backend/test/http-app.test.cjs`), and the public updates guide describes Stable as visible but not yet installable instead of "the right choice once you depend on your suite".
- **Regression check:** No UI or docs surface may present Stable as installable until tagged stable discovery, checkout, version reporting, and apply exist end to end; the service-level refusal must stay ahead of the agent's branch-only rejection.
- **Acceptance (for lifting read-only):** A released tag can be discovered and applied end to end on a representative install, including full runtime reconciliation, with installed-version metadata updated truthfully.

#### 3. Public cloud onboarding must not depend on plain HTTP — completed, retain as a regression check

- **Severity:** Blocker for supported public cloud installs; High if explicitly experimental
- **Area:** Security and installation
- **Original evidence:** The DigitalOcean and generic cloud guides directed users to `http://home.<ip>.sslip.io/` to create the first owner. Anyone who reached an unclaimed install could become owner, and session cookies became `Secure` only over HTTPS.
- **Resolution evidence:** Public VPS installs now configure Caddy automatic HTTPS for `home.<ip>.sslip.io`, open only SSH/HTTP/HTTPS through UFW, and require a random one-time claim token for first-owner creation. Public HTTP remains available only for a non-secret setup diagnostic and the backend rejects owner creation unless the request is HTTPS with the correct token. A fresh Ubuntu 24.04 DigitalOcean Droplet installed through `get-dev.myownsuite.org` reached trusted HTTPS and completed the protected owner-claim flow on July 13, 2026. Focused backend and installer-contract tests cover HTTP rejection, invalid-token rejection, secure cookies, and the public-VPS rendering contract. On July 21, 2026 the owner re-verified the flow on a fresh Droplet installed through the stable `get.myownsuite.org` endpoint, including the previously untested negative case on real hardware: owner creation was refused without the claim-token URL and succeeded only with it.
- **Regression check:** The DigitalOcean smoke harness consumes the hosted development installer, waits for HTTPS readiness, and retrieves the root-only claim token over configured SSH solely to print the one-time setup URL; it must never persist the token in smoke state or harness-created log files.
- **Acceptance:** A new cloud install cannot be claimed by an unauthorised remote visitor, and owner credentials/session cookies are never sent over public HTTP.

#### 4. Deliver and continuously exercise the advertised pipe-to-shell installer

- **Severity:** Blocker before site cutover/public announcement — completed, retain as a regression check
- **Area:** Product and installation
- **Original evidence:** `site/src/components/InstallPaths.astro` advertised `curl -fsSL https://get.myownsuite.org | sh`, while the documented implementation required cloning the repository and rendering an installer payload.
- **Resolution evidence:** Repository-owned Cloudflare Workers now serve separate stable and development installer endpoints. `get.myownsuite.org` tracks `main`; `get-dev.myownsuite.org` tracks the branch configured in the development Worker's version-controlled Wrangler configuration. Each request resolves that branch to an exact Git commit and renders the shared bootstrap pinned to that commit. Cloudflare Git integration deploys the Workers from their respective branches, keeping repository code as the source of truth. Installer contract/render checks pass, and the DigitalOcean reset smoke harness successfully installed through `get-dev.myownsuite.org` on Ubuntu 24.04.
- **Regression check:** Keep the stable and development Workers separate, keep both configurations in the repository, and make the DigitalOcean and Hyper-V installation harnesses consume the public development endpoint instead of maintaining alternate installation paths.
- **Acceptance:** The advertised stable command is exercised after a real release reaches `main`; ongoing pre-release smoke coverage exercises the same installer contract through `get-dev.myownsuite.org`, whose response is pinned to the exact resolved commit.
- **Stable-endpoint exercise (July 21, 2026):** after the MOS layout reached `main`, the owner ran the advertised `curl -fsSL https://get.myownsuite.org | sudo bash` on a fresh DigitalOcean Ubuntu 24.04 Droplet. The stable Worker served the MOS bootstrap pinned to the resolved `main` commit, the install reached trusted HTTPS, and the owner completed setup through the protected claim URL.

#### 5. Remove obsolete owner credentials from the USB installer

- **Severity:** High — completed, retain as a regression check
- **Area:** Installation, documentation, and secret handling
- **Original evidence:** The ISO builder and `selfhost-installer.env.template` required `OWNER_NAME`, `OWNER_EMAIL`, and `OWNER_PASSWORD`, even though MOS creates the owner only in the browser.
- **Resolution evidence:** The `Unreleased` changelog records removal of the V1 owner fields and dead validation, a zero-configuration USB build, and updated own-hardware guidance.
- **Regression check:** Installer input and generated seed must never contain Suite Manager owner credentials. Only the machine login and legitimate host settings may be installer inputs.
- **Acceptance:** Static installer tests reject owner credential inputs, and a fresh USB install reaches browser owner creation without placeholder secrets.

#### 6. Backup integrity and fresh-machine restore claims must be proven — completed, retain as a regression check

- **Severity:** High
- **Area:** Backup, restore, and documentation
- **Original evidence:** The guide describes bundles as integrity-checked and sufficient to restore the suite on a fresh machine. The reviewed implementation hashed `manifest.json`, but not every state/volume archive, and restore operated on an already-installed MOS machine. Version matching was advised rather than visibly enforced.
- **Why it matters:** Payload corruption may go undetected until restore, and "fresh machine" can be read as bare-metal recovery even though a compatible MOS installation is a prerequisite.
- **Resolution evidence:** Bundle schema v3 hashes every state and volume archive; restore and the read-only bundle check verify all checksums, archive readability, and app package payloads before anything is stopped, enforce a declared schema-version window, and surface a recorded-vs-current MOS version mismatch as an explicit warning. Restores keep a complete rescue generation, run under a durable journal that blocks new work after interruption until typed acknowledgment, and report success only after the restored inventory verifies against the bundle. Hyper-V drills on July 20-21, 2026 confirmed each acceptance point on real hardware: deliberately corrupted archives (stream-level and checksum-level) and an out-of-window schema version were rejected before any destructive step; a replacement-VM recovery succeeded using only a downloaded bundle uploaded through the Backups screen plus the owner password; and a mid-restore power loss ended in journaled, acknowledgeable recovery rather than a false success. The restore guarantee reported by the API and Backups screen moved from `experimental` to `verified`, with replacement-machine prerequisites (a compatible installed MOS) documented. Full drill log: `docs/backup-restore-reliability-plan.md`.
- **Regression check:** Bundles must not gain payload types that escape per-archive hashing; restore preflight must keep running every integrity/compatibility check before the first destructive step; and restore success must remain gated on inventory verification, never inferred from job completion.
- **Acceptance:** A deliberately corrupted state or volume archive is rejected before destructive restore begins, incompatible versions are blocked or explicitly migrated, and a documented replacement-machine recovery drill succeeds.

#### 7. MOS public site must be CI-validated before cutover — completed, retain as a regression check

- **Severity:** High before announcement; Medium before code-only main cutover
- **Area:** Repository, CI, and deployment
- **Original evidence:** At review time, root `npm run build`, CI, and `wrangler.toml` still targeted `site-mos1-reference`, while `site/` had no required clean-build job. Active README wording also called the rebuilt site a placeholder.
- **Why it matters:** The launch surface can fail only after deployment, while the live site may continue telling the MOS1 story.
- **Resolution evidence (July 21, 2026):** The `MOS Site` CI job builds `site/` from a clean `npm ci` on every branch; its first GitHub run caught seven `site/package-lock.json` integrity hashes corrupted by the generation-label rename (`V2` → `MOS` inside base64), which were repaired with registry-verified values and re-validated by a clean local `npm ci` + build. The deployment cutover is implemented: `.github/workflows/deploy-site.yml` builds `site/` and runs `wrangler pages deploy` on pushes to `main` (production) and `staging` (aliased preview) only; root `npm run build` and `wrangler.toml` now target `site/dist`; the MOS1 reference site is retired from CI and deployment and its folder kept as frozen reference. Decision and rollback path recorded in `docs/decisions.md` (2026-07-21).
- **Owner-side completion (July 21, 2026):** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets added; `MOS Site` marked required in the `main` branch protection ruleset; the Pages project's git integration disconnected so only workflow-driven direct-upload deploys remain possible. The first `Deploy Site` runs succeeded on `staging` (PR #179) and `main` (PR #180) the same day: myownsuite.org serves the rebuilt MOS site with beta labeling, docs pages render from the Starlight build, and `get.myownsuite.org` serves the MOS bootstrap pinned to the exact new `main` head commit.
- **Regression check:** the site must keep building from a clean install in required CI, and deployment must only ever happen from `main` and `staging` through the deploy workflow.
- **Acceptance:** Required CI builds `site/` from a clean checkout on Linux, and the deployment cutover is a reviewed change with a rollback path.

#### 8. Cloud HTTPS guidance must describe a real supported path — completed, retain as a regression check

- **Severity:** High
- **Area:** Installation, security, and documentation
- **Original evidence:** Cloud docs deferred custom-domain TLS to provider tooling, while a plain Ubuntu VPS commonly supplies no TLS termination for arbitrary services.
- **Resolution evidence:** The hosted installer discovers the VPS public IPv4, uses `sslip.io` for the initial hostname, configures Caddy to obtain and renew a publicly trusted certificate, and prints the protected HTTPS owner setup URL. The DigitalOcean manual-install validation required no provider-dashboard networking or DNS steps beyond creating the Ubuntu 24.04 Droplet.
- **Regression check:** Keep the hosted installer, DigitalOcean harness, generic cloud guide, and HTTPS failure diagnostic aligned. Providers that block required ingress must receive a clear diagnostic and must not fall back to owner creation over HTTP.
- **Acceptance:** A user following only the supported guide reaches a trusted HTTPS Home URL without undocumented infrastructure steps.

#### 9. Narrow privacy claims to guarantees MOS controls — completed, retain as a regression check

- **Severity:** Medium
- **Area:** Product positioning and privacy
- **Evidence:** Landing copy claimed MOS strips third-party fonts, remote icons, and app analytics, and implied only the owner holds the keys. MOS can control its UI and package defaults but cannot make an evergreen guarantee for every upstream app; cloud providers also retain infrastructure control unless owner-held encryption is used.
- **Why it matters:** Privacy is the core trust proposition, so absolute but unverifiable claims create disproportionate reputational risk.
- **Required action:** Say that MOS itself sends no telemetry by default and self-hosts its own assets. Make upstream app behavior package/version-specific and describe the cloud-provider trust tradeoff.
- **Resolution evidence:** The landing page now limits its platform claim to MOS-owned telemetry and self-hosted assets, and no longer claims that MOS universally strips upstream analytics. App privacy is package/version/digest-specific: Stirling PDF is the first and currently only assessed app, its supported analytics setting is disabled in the package, and every other catalog app is visibly marked **Not yet rated by MOS** rather than inheriting a favorable claim. The public privacy policy, terms, assessment methodology, catalog, app guide, and Suite Manager distinguish evidence-backed MOS assessments from unverified package-authored statements and external packages, disclose outbound connections and cloud-provider trust boundaries, and label AI-assisted review provenance. Schema and repository checks derive posture from recorded dimensions, require evidence for favorable ratings, and reject unknown findings presented as a favorable posture.
- **Regression check:** Keep platform behavior, upstream-package assessments, external-package claims, and public-site analytics described separately. A new or updated app must remain unrated until an assessment bound to its exact package identity passes the repository checks.
- **Acceptance:** Every privacy claim maps to a testable MOS behavior or a clearly scoped upstream-package statement.


#### 10. Clarify backup availability by installation type — completed, retain as a regression check

- **Severity:** Medium
- **Area:** Backup and product positioning
- **Evidence:** Top-level messaging presents backup as a platform capability across deployment paths, while the documented implementation is manual and local/mounted-drive oriented. Plugging a USB disk into a rented VPS is generally impossible.
- **Why it matters:** Cloud users may discover after storing data that the promoted backup flow has no practical supported destination for them.
- **Required action:** Mark whole-suite backup as own-hardware/local-mount oriented until cloud/object destinations exist. If provider snapshots are suggested, document their external nature and consistency/restore limitations.
- **Resolution evidence:** The backup guide, own-hardware guide, DigitalOcean guide, generic cloud guide, first-start guidance, landing copy, FAQ, and Suite Manager now distinguish the supported destinations. Own hardware uses an encrypted USB/external drive attached to the MOS machine; cloud servers use a separately attached and mounted provider block-storage volume. Direct object-storage destinations are explicitly unsupported, and provider snapshots are described as an external, provider-managed supplement whose consistency and restore behavior MOS cannot verify.
- **Regression check:** Every supported installation path must name a destination that the server can actually mount, and new destination types must not be advertised before backup and restore support exists.
- **Acceptance:** Each supported install guide states exactly which backup destinations and restore procedure apply to that install type.

#### 11. Harden internet-facing login against brute force — completed, retain as a regression check

- **Severity:** Medium
- **Area:** Authentication security
- **Evidence:** Password hashing and session-token hashing are strong, but the review found no obvious rate limiter, progressive delay, or bounded lockout around owner login.
- **Why it matters:** A public control-plane endpoint permits sustained online password guessing against the only privileged account.
- **Required action:** Add per-IP and per-account throttling or progressive delay, bounded recovery behavior, and secret-free security event logging. State clearly that MFA is not yet available.
- **Resolution evidence:** Suite Manager applies bounded, expiring progressive backoff per client address and a looser account-wide limit, returns `429` with `Retry-After`, clears applicable state after successful authentication, and emits security events containing only a one-way client fingerprint and retry duration. Events persist as hourly SQLite aggregates with 30-day retention and a 5,000-row hard cap so later owner-facing monitoring cannot become an attacker-controlled raw log. Forwarded addresses are accepted only from the loopback Caddy boundary. Focused tests cover progressive caps, distributed attempts, recovery, bounded memory and database storage, forwarding-header trust, persistence across restart, retention, the HTTP retry contract, and secret-free events. Public Suite Manager guidance states that MFA and passkeys are not yet available.
- **Acceptance:** Automated repeated failures are throttled without enabling trivial permanent denial of service, with focused tests covering reset and proxy-address handling.

#### 12. Treat unencrypted backup bundles as full-secret exports — completed, retain as a regression check

- **Severity:** Medium
- **Area:** Backup security
- **Evidence:** Bundles include Suite Manager state, app data/secrets, and HTTPS-related secret state. The guide correctly warns they are unencrypted but also suggests downloading a bundle to store elsewhere.
- **Why it matters:** Loss of removable media, browser downloads, or casual copying to cloud storage can expose essentially the entire suite and provider credentials.
- **Required action:** Keep the warning adjacent to every create/download action, recommend encrypted media/storage, avoid casual "stash elsewhere" wording, and prioritise authenticated encryption with a recoverable key workflow.
- **Resolution evidence:** Suite Manager now presents the full-secret warning above backup creation and again beside browser download actions. The backup guide identifies app data, owner/app credentials, Suite Manager state, and HTTPS/provider secrets; recommends encrypted, access-controlled destinations; removes the casual download-and-stash instruction; and tells owners to remove unneeded browser copies. The post-cutover encryption item now groups payload integrity, authenticated encryption, key export, recovery, loss, and rotation as one design problem.
- **Regression check:** Any new create, export, or download surface must warn before the bundle leaves MOS-managed storage and must not imply that an unencrypted browser or cloud copy is safe.
- **Acceptance:** UI and docs explain the full-secret nature before creation/download, and the roadmap issue defines encryption, integrity, and key-recovery requirements together.

#### 13. Remove stale scaffold and MOS1 wording from active MOS docs — completed, retain as a regression check

- **Severity:** Low
- **Area:** Repository maintenance and documentation
- **Evidence:** The review found active files calling `site/` a future placeholder, app packages future work, and host agents placeholders despite all being implemented. Historical generation labels and MOS1 references also remained in release-shaped material.
- **Why it matters:** Contributors, users, and future agents can follow obsolete architecture assumptions.
- **Required action:** Sweep active docs for `future`, `placeholder`, stale generation labels, `V1`, and `MOS1`; retain references only where they explain archives, migrations, or compatibility.
- **Resolution evidence:** Root, documentation-ownership, public-site, script, infrastructure, app-package, and Suite Manager READMEs now describe the implemented MOS layout and current ownership. Placeholder/future implementation statements and V1-era product framing were removed. References to the previous site or root layout remain only to identify isolated rollback/history sources or an explicit compatibility boundary.
- **Regression check:** Active documentation must describe current root paths. Historical names belong only in archive, migration, rollback, or compatibility context.
- **Acceptance:** Root README, site README, app/system-agent/script references, docs ownership map, and current public docs all describe the same MOS layout and deployment status.

#### 13a. Remove the temporary development-generation label — completed, retain as a regression check

- **Severity:** Low
- **Area:** Repository maintenance and naming
- **Original evidence:** MOS was developed in an isolated prototype workspace whose filenames, identifiers, runtime paths, configuration, and documentation used a numbered generation label even though the repository does not maintain two MOS generations in parallel.
- **Resolution evidence:** MOS-owned source and active documentation now use durable product or capability names instead of encoding the prototype generation. Genuine upstream versions, including dependency releases and third-party API paths, retain their published identifiers.
- **Regression check:** Do not introduce a numbered MOS generation label unless the project deliberately adopts parallel product generations. Upstream API and dependency version strings are not MOS generation labels and must not be rewritten.
- **Acceptance:** Repository scans find no numbered generation label in MOS-owned filenames, functions, variables, runtime contracts, or active documentation; any matching version string is demonstrably owned by an upstream dependency or API.

#### 14. Make the changelog release-shaped — completed, retain as a regression check

- **Severity:** Low
- **Area:** Release documentation
- **Evidence:** `Unreleased` contains long iterative MOS implementation history, follow-up fixes, and intermediate architecture states.
- **Why it matters:** Users cannot quickly identify final outcomes, compatibility changes, security implications, and known beta limits.
- **Required action:** Consolidate into broad `Added`, `Changed`, `Fixed`, `Security`, `Compatibility`, and `Known limitations` sections. Preserve material user/operations facts, not the branch work log.
- **Resolution evidence:** `Unreleased` is now organized into `Added`, `Changed`, `Fixed`, `Security`, `Compatibility`, and `Known limitations`, with broad MOS outcomes and explicit beta/release gates replacing the chronological implementation diary.
- **Regression check:** Follow-up fixes in the same release area must update an existing outcome bullet unless they add a distinct user-visible, operational, security, or compatibility result.
- **Acceptance:** Release notes can be derived directly from the changelog without reconstructing which later bullets supersede earlier ones.

### What is already strong and must not regress

- [x] The previous site and previous root layout remain clearly isolated in `site-mos1-reference/` and the archive branch rather than mixed into the MOS runtime.
- [x] App packages remain manifest-driven with digest-pinned base images and root-level Dockerfile paths. (Verified July 21, 2026: all 11 `apps/*/Dockerfile*` pin `@sha256:` digests, no floating tags, flat layout; projections rendered from manifests in `app-package-internals.cjs`.)
- [x] ONLYOFFICE remains an independent capability provider/Seafile companion rather than being presented as a standalone file cloud. (Verified: `capability-provider` role, companion treatment in Suite Manager, companion framing in catalog and docs.)
- [x] Stop remains non-destructive; uninstall remains explicitly destructive and removes declared containers, routes, Homepage entries, state, secrets, integrations, and volumes. (Verified in `app-package-service.cjs` disable/uninstall paths; the previously missing UI confirmation now exists — uninstall requires a dialog spelling out data deletion, and Stop is labeled as keeping data.)
- [x] Suite Manager remains unprivileged and delegates bounded host work to narrow Unix-socket agents. (Verified: `mos` user unit, loopback bind, no Docker socket; root agents behind `/run/mos-*-agent/agent.sock` with group-scoped socket dirs; docker.sock/host-device mounts rejected in package contracts.)
- [x] Cloudflare tokens remain in root-only storage and are never returned by the API or printed in logs. (Verified: `0600` root-agent env file, pass-through without persistence, boolean-only status, log redaction.)
- [x] Owner passwords remain scrypt-hashed and only hashes of session tokens persist. (Verified: scrypt with timing-safe compare; SHA-256 session-token hashes only in the store.)
- [x] Homepage remains loopback-only and protected by the Suite Manager session boundary. (Verified: `127.0.0.1` publish, session-gated HTTP proxy and WebSocket upgrades, cookie stripping both ways.)
- [x] App secrets remain redacted from public projections and API responses. (Verified: secret values never serialized in `publicConfig`; projections keep placeholders unless materialized for the root agent.)
- [x] MOS-owned Homepage links can be reconciled without rewriting arbitrary user-authored links. (Verified: `reconcileManagedUrls` mutates only entries whose `mos.id` matches the target set, via CST-level YAML edits.)

### Beta caveats required in public documentation and release notes

- [x] MOS is pre-1.0 and intended for evaluation or non-critical use with independent backups. (Beta/0.x labeling across landing, footer, docs, and terms; the FAQ beta answer and getting-started now state evaluation/non-critical use with independent backups explicitly.)
- [x] Cloud security/TLS and remote-access responsibilities are stated without implying provider tooling automatically supplies HTTPS. (Cloud guides and the HTTPS settings screen state MOS does not manage provider DNS/TLS; the quick cloud path is described honestly.)
- [x] Backups are manual, unencrypted, whole-suite only, destination-limited, and version-sensitive.
- [x] Replacement-machine restore prerequisites are explicit.
- [x] Stable-track managed apply status is stated accurately. (Updates guide describes Stable as visible but not yet installable; the Updates screen keeps it read-only and refuses stable apply.)
- [x] App package changes that are not automatically reconciled are stated before an update starts. (The Updates screen states at the action point that installed apps stay on their snapshots and update separately; the updates guide documents the same contract.)
- [x] MFA availability and login-hardening status are explicit.
- [x] Own-hardware setup requirements include USB creation, disk erasure, LAN addressing, and DNS/hosts configuration. (All four covered in the own-hardware install guide.)
- [x] Immich resource and backup-size expectations are prominent. (The Immich resource hint now covers RAM/AVX2 and backup-size/duration expectations; rendered on the public app page and the Suite Manager resources tile.)
- [x] ONLYOFFICE's companion role is clear.
- [x] Uninstall data deletion and Stop data preservation are clear at the action point. (Uninstall now opens a confirmation dialog listing exactly what is deleted and pointing to backup first; the Stop menu item is labeled as keeping data.)

### Suggested post-cutover issues

- [ ] Authenticated-encryption backup format covering payload integrity, encryption at rest, authentication, key export, and recoverable-key loss/rotation workflows.
- [ ] Scheduled backups, retention policy, and object/object-storage destinations.
- [ ] Package-aware transactional updates and rollback.
- [ ] Stable tagged-release updates and installed-version metadata.
- [ ] Owner-facing security event monitoring and optional MFA/passkeys; login throttling and bounded event persistence are complete.
- [x] Secure one-time first-owner bootstrap claim.
- [x] Tested cloud HTTPS and reference firewall automation.
- [ ] Restore compatibility migrations and a bare-metal recovery runbook.
- [ ] Per-app consistency hooks for databases and large media stores.
- [ ] Resource estimation/preflight for Immich, Seafile, and ONLYOFFICE.
- [ ] Automated stale-wording checks for active documentation.
- [ ] Site link, accessibility, and clean-build checks.
- [ ] Signed release and installer artifacts.

### Approved launch framing

Prefer wording at this level of confidence:

> My Own Suite is an open-source, self-hosted app launcher for running private apps on hardware you control. MOS is currently beta: installation and recovery still require some technical comfort, but everyday app management happens in one browser interface.

For the main-cutover announcement:

> MOS is now the project's default codebase. This is a beta milestone, not a production-appliance declaration. It introduces browser owner setup, an authenticated dashboard, manifest-driven app installation, private LAN HTTPS, manual whole-suite backups, and early managed updates. Review the known limitations before storing irreplaceable data.

Avoid until the corresponding acceptance criteria above are met:

- "One-click updates" without precise runtime-reconciliation scope.
- "Everything included" backups without recovery prerequisites.
- "Only you hold the keys" for rented cloud servers.
- Claims that MOS universally removes upstream app analytics.
- "Safe to use" without the intended beta risk profile.
