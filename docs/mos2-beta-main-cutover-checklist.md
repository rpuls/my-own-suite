# MOS2 Beta Main-Cutover Release Checklist

This temporary, release-specific document tracks the MOS2 beta main cutover and its separate public announcement. It records the July 2026 helicopter review and should be removed or replaced with release notes after this release is complete. A checked item means the repository evidence has been updated and the relevant validation has passed; wording changes alone do not close an implementation or security item.

The two decisions are intentionally separate:

- **Main cutover:** MOS2 becomes the repository default, clearly labeled beta.
- **Public launch:** the MOS2 site and installation paths are promoted to new users.

### At-a-glance gate

#### Blockers before main cutover

- [ ] Managed updates apply all repo-owned app runtime changes before reporting success, or managed apply is disabled and described as experimental.
- [ ] The Stable update track can actually apply tagged releases, or its apply controls and claims are removed until supported.
- [x] Public cloud first-owner setup and subsequent owner authentication no longer rely on exposed plain HTTP, or cloud installation is explicitly removed from the supported beta paths.
- [x] The landing-page one-line installer is implemented, tested, and safely delivered, or the unsupported command is removed.

#### High priority before public announcement

- [x] Remove obsolete USB-installer owner fields and make browser owner creation the only owner bootstrap path.
- [ ] Make backup integrity and replacement-machine restore claims match verified behavior.
- [ ] Build the MOS2 `site/` from a clean install in required CI before deployment cutover.
- [x] Publish a real, tested cloud HTTPS procedure or clearly classify cloud TLS as operator-owned and advanced.

#### Beta truthfulness and security

- [ ] Narrow absolute privacy claims to behavior MOS can actually guarantee.
- [ ] Replace "no sysadmin required" and optimistic install-time promises with beta-appropriate expectations.
- [ ] State clearly which backup destinations work on own hardware and cloud servers.
- [ ] Add login throttling/progressive delay for an internet-reachable control plane.
- [ ] Keep the unencrypted-backup warning prominent and avoid suggesting casual storage of downloaded bundles.
- [ ] Remove stale scaffold/MOS1 wording from active MOS2 documentation.
- [ ] Condense `CHANGELOG.md` into release-shaped MOS2 outcomes and explicit known limitations.

#### Required validation before approval

- [ ] `npm run release:check`
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build:client`
- [ ] Clean MOS2 `site/` install and build in CI
- [x] Installer contract/render checks
- [ ] Human-run Hyper-V full-platform E2E after blocker fixes
- [ ] Real backup/restore drill with representative multi-service and large-data apps
- [x] Explicitly approved DigitalOcean validation if cloud install remains a supported launch path
- [ ] Branch protection requires PRs and passing CI for `main`
- [ ] Release metadata, changelog, tag, and release notes agree

### Detailed findings and acceptance criteria

#### 1. Managed updates must fully apply repo-owned app code

- **Severity:** Blocker
- **Area:** Updates and release architecture
- **Evidence:** `AGENTS.md` requires managed updates to apply all repo-owned code. `system-agents/update/lib.cjs` currently reports `manual-reapply-after-core-update`, and `system-agents/README.md` says changed package Dockerfiles or manifests may require owners to reapply or restart apps after a core update.
- **Why it matters:** An update can report success while installed containers continue running images built from old repo-owned package code. That contradicts the repository's update contract and the public one-click update story.
- **Required action:** Make package-aware rebuild/reapply part of the managed update transaction. If that cannot ship for beta, disable managed apply or label it experimental and do not report full update success while runtime code remains stale.
- **Acceptance:** A test update that changes an installed app Dockerfile or manifest leaves the running app on the new projection/image without manual action, or the UI prevents the unsupported operation and states the limitation before starting.

#### 2. Stable update track is advertised but cannot apply

- **Severity:** Blocker
- **Area:** Updates and releases
- **Evidence:** The Updates guide and UI present Stable releases as a selectable track. `system-agents/update/lib.cjs` rejects apply unless the selected track is `branch`. `RELEASING.md` also notes that MOS2 stable release-track metadata is not complete.
- **Why it matters:** Selecting the supposedly safer update channel disables the principal update operation and can leave users without a dependable security-update path.
- **Required action:** Implement tagged stable release discovery, checkout, version reporting, and apply, or make Stable visibly unavailable/read-only until it exists.
- **Acceptance:** A released tag can be discovered and applied end to end on a representative install, including full runtime reconciliation, with installed-version metadata updated truthfully.

#### 3. Public cloud onboarding must not depend on plain HTTP — completed, retain as a regression check

- **Severity:** Blocker for supported public cloud installs; High if explicitly experimental
- **Area:** Security and installation
- **Original evidence:** The DigitalOcean and generic cloud guides directed users to `http://home.<ip>.sslip.io/` to create the first owner. Anyone who reached an unclaimed install could become owner, and session cookies became `Secure` only over HTTPS.
- **Resolution evidence:** Public VPS installs now configure Caddy automatic HTTPS for `home.<ip>.sslip.io`, open only SSH/HTTP/HTTPS through UFW, and require a random one-time claim token for first-owner creation. Public HTTP remains available only for a non-secret setup diagnostic and the backend rejects owner creation unless the request is HTTPS with the correct token. A fresh Ubuntu 24.04 DigitalOcean Droplet installed through `get-dev.myownsuite.org` reached trusted HTTPS and completed the protected owner-claim flow on July 13, 2026. Focused backend and installer-contract tests cover HTTP rejection, invalid-token rejection, secure cookies, and the public-VPS rendering contract.
- **Regression check:** The DigitalOcean smoke harness consumes the hosted development installer, waits for HTTPS readiness, and retrieves the root-only claim token over configured SSH solely to print the one-time setup URL; it must never persist the token in smoke state or harness-created log files.
- **Acceptance:** A new cloud install cannot be claimed by an unauthorised remote visitor, and owner credentials/session cookies are never sent over public HTTP.

#### 4. Deliver and continuously exercise the advertised pipe-to-shell installer

- **Severity:** Blocker before site cutover/public announcement — completed, retain as a regression check
- **Area:** Product and installation
- **Original evidence:** `site/src/components/InstallPaths.astro` advertised `curl -fsSL https://get.myownsuite.org | sh`, while the documented implementation required cloning the repository and rendering an installer payload.
- **Resolution evidence:** Repository-owned Cloudflare Workers now serve separate stable and development installer endpoints. `get.myownsuite.org` tracks `main`; `get-dev.myownsuite.org` tracks the branch configured in the development Worker's version-controlled Wrangler configuration. Each request resolves that branch to an exact Git commit and renders the shared bootstrap pinned to that commit. Cloudflare Git integration deploys the Workers from their respective branches, keeping repository code as the source of truth. Installer contract/render checks pass, and the DigitalOcean reset smoke harness successfully installed through `get-dev.myownsuite.org` on Ubuntu 24.04.
- **Regression check:** Keep the stable and development Workers separate, keep both configurations in the repository, and make the DigitalOcean and Hyper-V installation harnesses consume the public development endpoint instead of maintaining alternate installation paths.
- **Acceptance:** The advertised stable command is exercised after a real release reaches `main`; ongoing pre-release smoke coverage exercises the same installer contract through `get-dev.myownsuite.org`, whose response is pinned to the exact resolved commit.

#### 5. Remove obsolete owner credentials from the USB installer

- **Severity:** High — completed, retain as a regression check
- **Area:** Installation, documentation, and secret handling
- **Original evidence:** The ISO builder and `selfhost-installer.env.template` required `OWNER_NAME`, `OWNER_EMAIL`, and `OWNER_PASSWORD`, even though MOS2 creates the owner only in the browser.
- **Resolution evidence:** The `Unreleased` changelog records removal of the V1 owner fields and dead validation, a zero-configuration USB build, and updated own-hardware guidance.
- **Regression check:** Installer input and generated seed must never contain Suite Manager owner credentials. Only the machine login and legitimate host settings may be installer inputs.
- **Acceptance:** Static installer tests reject owner credential inputs, and a fresh USB install reaches browser owner creation without placeholder secrets.

#### 6. Backup integrity and fresh-machine restore claims must be proven

- **Severity:** High
- **Area:** Backup, restore, and documentation
- **Evidence:** The guide describes bundles as integrity-checked and sufficient to restore the suite on a fresh machine. The reviewed implementation hashed `manifest.json`, but not every state/volume archive, and restore operated on an already-installed MOS machine. Version matching was advised rather than visibly enforced.
- **Why it matters:** Payload corruption may go undetected until restore, and "fresh machine" can be read as bare-metal recovery even though a compatible MOS installation is a prerequisite.
- **Required action:** Hash every payload archive, verify all checksums before stopping services, validate/enforce compatible versions, and describe replacement-machine prerequisites precisely.
- **Acceptance:** A deliberately corrupted state or volume archive is rejected before destructive restore begins, incompatible versions are blocked or explicitly migrated, and a documented replacement-machine recovery drill succeeds.

#### 7. MOS2 public site must be CI-validated before cutover

- **Severity:** High before announcement; Medium before code-only main cutover
- **Area:** Repository, CI, and deployment
- **Evidence:** At review time, root `npm run build`, CI, and `wrangler.toml` still targeted `site-mos1-reference`, while `site/` had no required clean-build job. Active README wording also called the rebuilt site a placeholder.
- **Why it matters:** The launch surface can fail only after deployment, while the live site may continue telling the MOS1 story.
- **Required action:** Add a clean dependency install and MOS2 site build to required CI, verify links/assets/routes, explicitly switch deployment configuration, and update active documentation.
- **Acceptance:** Required CI builds `site/` from a clean checkout on Linux, and the deployment cutover is a reviewed change with a rollback path.

#### 8. Cloud HTTPS guidance must describe a real supported path — completed, retain as a regression check

- **Severity:** High
- **Area:** Installation, security, and documentation
- **Original evidence:** Cloud docs deferred custom-domain TLS to provider tooling, while a plain Ubuntu VPS commonly supplies no TLS termination for arbitrary services.
- **Resolution evidence:** The hosted installer discovers the VPS public IPv4, uses `sslip.io` for the initial hostname, configures Caddy to obtain and renew a publicly trusted certificate, and prints the protected HTTPS owner setup URL. The DigitalOcean manual-install validation required no provider-dashboard networking or DNS steps beyond creating the Ubuntu 24.04 Droplet.
- **Regression check:** Keep the hosted installer, DigitalOcean harness, generic cloud guide, and HTTPS failure diagnostic aligned. Providers that block required ingress must receive a clear diagnostic and must not fall back to owner creation over HTTP.
- **Acceptance:** A user following only the supported guide reaches a trusted HTTPS Home URL without undocumented infrastructure steps.

#### 9. Narrow privacy claims to guarantees MOS controls

- **Severity:** Medium
- **Area:** Product positioning and privacy
- **Evidence:** Landing copy claimed MOS strips third-party fonts, remote icons, and app analytics, and implied only the owner holds the keys. MOS can control its UI and package defaults but cannot make an evergreen guarantee for every upstream app; cloud providers also retain infrastructure control unless owner-held encryption is used.
- **Why it matters:** Privacy is the core trust proposition, so absolute but unverifiable claims create disproportionate reputational risk.
- **Required action:** Say that MOS itself sends no telemetry by default and self-hosts its own assets. Make upstream app behavior package/version-specific and describe the cloud-provider trust tradeoff.
- **Acceptance:** Every privacy claim maps to a testable MOS behavior or a clearly scoped upstream-package statement.

#### 10. Set honest technical-skill and installation-time expectations

- **Severity:** Medium
- **Area:** Product and user experience
- **Evidence:** Landing copy used "no sysadmin required" and short install-time estimates, while own-hardware setup requires ISO creation, disk erasure, router discovery, stable addressing, and local DNS/hosts work. Cold installs also build components and may take longer than optimistic estimates.
- **Why it matters:** The current language creates a consumer-appliance expectation that the beta does not consistently meet.
- **Required action:** Prefer "designed to reduce routine administration," separate installation complexity from everyday browser management, and publish conservative ranges with troubleshooting expectations.
- **Acceptance:** A non-expert usability pass confirms the public copy predicts the real install work and recovery responsibilities.

#### 11. Clarify backup availability by installation type

- **Severity:** Medium
- **Area:** Backup and product positioning
- **Evidence:** Top-level messaging presents backup as a platform capability across deployment paths, while the documented implementation is manual and local/mounted-drive oriented. Plugging a USB disk into a rented VPS is generally impossible.
- **Why it matters:** Cloud users may discover after storing data that the promoted backup flow has no practical supported destination for them.
- **Required action:** Mark whole-suite backup as own-hardware/local-mount oriented until cloud/object destinations exist. If provider snapshots are suggested, document their external nature and consistency/restore limitations.
- **Acceptance:** Each supported install guide states exactly which backup destinations and restore procedure apply to that install type.

#### 12. Harden internet-facing login against brute force

- **Severity:** Medium
- **Area:** Authentication security
- **Evidence:** Password hashing and session-token hashing are strong, but the review found no obvious rate limiter, progressive delay, or bounded lockout around owner login.
- **Why it matters:** A public control-plane endpoint permits sustained online password guessing against the only privileged account.
- **Required action:** Add per-IP and per-account throttling or progressive delay, bounded recovery behavior, and secret-free security event logging. State clearly that MFA is not yet available.
- **Acceptance:** Automated repeated failures are throttled without enabling trivial permanent denial of service, with focused tests covering reset and proxy-address handling.

#### 13. Treat unencrypted backup bundles as full-secret exports

- **Severity:** Medium
- **Area:** Backup security
- **Evidence:** Bundles include Suite Manager state, app data/secrets, and HTTPS-related secret state. The guide correctly warns they are unencrypted but also suggests downloading a bundle to store elsewhere.
- **Why it matters:** Loss of removable media, browser downloads, or casual copying to cloud storage can expose essentially the entire suite and provider credentials.
- **Required action:** Keep the warning adjacent to every create/download action, recommend encrypted media/storage, avoid casual "stash elsewhere" wording, and prioritise authenticated encryption with a recoverable key workflow.
- **Acceptance:** UI and docs explain the full-secret nature before creation/download, and the roadmap issue defines encryption, integrity, and key-recovery requirements together.

#### 14. Remove stale scaffold and MOS1 wording from active MOS2 docs

- **Severity:** Low
- **Area:** Repository maintenance and documentation
- **Evidence:** The review found active files calling `site/` a future placeholder, app packages future work, and host agents placeholders despite all being implemented. Historical `version-2` and MOS1 references also remained in release-shaped material.
- **Why it matters:** Contributors, users, and future agents can follow obsolete architecture assumptions.
- **Required action:** Sweep active docs for `future`, `placeholder`, `version-2`, `V1`, and `MOS1`; retain references only where they explain archives, migrations, or compatibility.
- **Acceptance:** Root README, site README, app/system-agent/script references, docs ownership map, and current public docs all describe the same MOS2 layout and deployment status.

#### 15. Make the changelog release-shaped

- **Severity:** Low
- **Area:** Release documentation
- **Evidence:** `Unreleased` contains long iterative V2 implementation history, follow-up fixes, and intermediate architecture states.
- **Why it matters:** Users cannot quickly identify final outcomes, compatibility changes, security implications, and known beta limits.
- **Required action:** Consolidate into broad `Added`, `Changed`, `Fixed`, `Security`, `Compatibility`, and `Known limitations` sections. Preserve material user/operations facts, not the branch work log.
- **Acceptance:** Release notes can be derived directly from the changelog without reconstructing which later bullets supersede earlier ones.

### What is already strong and must not regress

- [ ] MOS1 remains clearly isolated in `site-mos1-reference/` and the archive branch rather than mixed into the MOS2 runtime.
- [ ] App packages remain manifest-driven with digest-pinned base images and root-level Dockerfile paths.
- [ ] ONLYOFFICE remains an independent capability provider/Seafile companion rather than being presented as a standalone file cloud.
- [ ] Stop remains non-destructive; uninstall remains explicitly destructive and removes declared containers, routes, Homepage entries, state, secrets, integrations, and volumes.
- [ ] Suite Manager remains unprivileged and delegates bounded host work to narrow Unix-socket agents.
- [ ] Cloudflare tokens remain in root-only storage and are never returned by the API or printed in logs.
- [ ] Owner passwords remain scrypt-hashed and only hashes of session tokens persist.
- [ ] Homepage remains loopback-only and protected by the Suite Manager session boundary.
- [ ] App secrets remain redacted from public projections and API responses.
- [ ] MOS-owned Homepage links can be reconciled without rewriting arbitrary user-authored links.

### Beta caveats required in public documentation and release notes

- [ ] MOS2 is pre-1.0 and intended for evaluation or non-critical use with independent backups.
- [ ] Cloud security/TLS and remote-access responsibilities are stated without implying provider tooling automatically supplies HTTPS.
- [ ] Backups are manual, unencrypted, whole-suite only, destination-limited, and version-sensitive.
- [ ] Replacement-machine restore prerequisites are explicit.
- [ ] Stable-track managed apply status is stated accurately.
- [ ] App package changes that are not automatically reconciled are stated before an update starts.
- [ ] MFA availability and login-hardening status are explicit.
- [ ] Own-hardware setup requirements include USB creation, disk erasure, LAN addressing, and DNS/hosts configuration.
- [ ] Immich resource and backup-size expectations are prominent.
- [ ] ONLYOFFICE's companion role is clear.
- [ ] Uninstall data deletion and Stop data preservation are clear at the action point.

### Suggested post-cutover issues

- [ ] Authenticated-encryption backup format with checksummed payloads and recoverable keys.
- [ ] Scheduled backups, retention policy, and object/object-storage destinations.
- [ ] Package-aware transactional updates and rollback.
- [ ] Stable tagged-release updates and installed-version metadata.
- [ ] Login throttling, a security event trail, and optional MFA/passkeys.
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

> My Own Suite is an open-source, self-hosted app launcher for running private apps on hardware you control. MOS2 is currently beta: installation and recovery still require some technical comfort, but everyday app management happens in one browser interface.

For the main-cutover announcement:

> MOS2 is now the project's default codebase. This is a beta milestone, not a production-appliance declaration. It introduces browser owner setup, an authenticated dashboard, manifest-driven app installation, private LAN HTTPS, manual whole-suite backups, and early managed updates. Review the known limitations before storing irreplaceable data.

Avoid until the corresponding acceptance criteria above are met:

- "No sysadmin required."
- "One-click updates" without precise runtime-reconciliation scope.
- "Everything included" backups without recovery prerequisites.
- "Only you hold the keys" for rented cloud servers.
- Claims that MOS universally removes upstream app analytics.
- "Safe to use" without the intended beta risk profile.
