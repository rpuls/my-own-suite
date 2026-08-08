# Decisions

This file records architectural decisions that should survive beyond a single issue or PR. Keep entries short, dated, and practical.

For documentation ownership rules, see [docs/README.md](./README.md).

## 2026-08-08: Machines Carry Whether They Are Disposable, And Both Installer Doors Land On The Published Release

Decision: The installer contract carries `MOS_DISPOSABLE_LAB`, a fact about the machine, rather than flags naming the features it unlocks. It is set only by the `lab` seed profile, defaults off, and is never inferred from anything else. The lab reset endpoint — which deletes every installed app's containers, networks and volumes — is gated on it alone. That endpoint is unauthenticated and must stay so: the end-to-end suite calls it to return a machine to first-run, when no owner account exists to authenticate as. Its containment is therefore absence, not authorization, and the release build fails if a publishable seed carries it. Separately, `get.myownsuite.org` resolves GitHub's `releases/latest` — the same call the update agent makes — so the hosted one-liner and the USB image both install the published release.

Reason: The flag was previously derived from the `usb-autoinstall` front door, which is shared by the disposable Hyper-V lab VM and every downloaded image, so a front door could not tell them apart. Two independent code paths made that same inference and v0.16.0 shipped an unauthenticated wipe endpoint to anyone who flashed it. A name that describes the machine cannot be re-derived from network shape by a later reader; a name that describes a feature invites exactly that. The installer channels had the mirror-image problem: production resolved `main` HEAD, so a fresh cloud install ran unreleased commits while its `VERSION` file, and therefore its update check, still reported the last release.

Consequences:

- `MOS_DISPOSABLE_LAB` replaces `MOS_LAB_RESET_ENABLED` in `bootstrap-contract.env` and the Suite Manager unit. A machine whose contract predates the name reads as not disposable, which closes the endpoint on v0.16.0 installs when they next update, and turns lab reset off on a lab VM that is updated rather than reflashed.
- Publishing a release switches the hosted one-liner on its own. The stable Worker is not redeployed per release.
- The USB image still pins its tag at build time, because its bootstrap script is generated at build time and would otherwise run against source it was never written for. Making that image version-independent means turning its seed into a launcher, which is not decided here.

## 2026-08-07: Releases Publish A Flashable Installer Image, Built By The Pipeline And Free Of Machine Identity

Decision: Pushing a `v*` tag is the entire release. `.github/workflows/release.yml` refuses a tag that is not on `main`, re-runs `npm test` and `npm run release:check -- --release <tag>`, renders the installer seed pinned to the tag, builds the ISO, uploads it to the Cloudflare R2 bucket `mos-downloads`, and only then publishes the GitHub Release with the download link and SHA256. `npm run release:prepare -- X.Y.Z` is the one command that prepares a release: it creates `release/vX.Y.Z`, writes `VERSION` and `releases/stable.json`, rolls `## [Unreleased]` into a dated section, and runs the same strict gate the pipeline runs. The published image is served from `downloads.myownsuite.org`, not as a GitHub release asset, because the Ubuntu 24.04 base puts it at ~3.2 GiB against a 2 GiB asset cap. Two properties are enforced before the build starts and are release-stopping: the seed must pin the tag rather than a branch, and it must carry no password. Nothing about a machine's identity or credentials may originate in the image — the console login is generated on first boot and handed over once through Suite Manager, and SSH host keys are generated on the target.

Reason: One image is flashed by everyone who downloads it, so anything decided at build time is shared by every install and extractable from the file. Building it once in CI also removes Node and Docker as prerequisites for the own-hardware path, which is what made that path technical at all. Having local preparation and CI run the same gate means there is one definition of "ready to release" and no way for them to disagree.

Consequences:

- `main` is protected (PR required, CI required, no force pushes) and the repository allows merge commits only, because a squashed release PR would rewrite the commit the tag is meant to point at.
- R2's S3 credentials live in `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; the S3 API is required because a multi-gigabyte upload needs multipart. `CLOUDFLARE_API_TOKEN` belongs to the site deployment and is not interchangeable.
- The workflow can be run manually to rehearse the build without publishing; those artifacts go to `dry-run/` and are never linked.
- R2's free tier holds roughly three images. Superseded releases will eventually need their notes repointed before a lifecycle rule expires their objects.
- A published image is frozen at release time, which makes the update path on first boot load-bearing for anyone flashing an older download.
- Still open, and not covered by this decision: booting the published image in CI before it publishes, and what an unattended installer may do to a stranger's disk.

## 2026-07-21: MOS Public Site Deployment Cutover To GitHub-Built Cloudflare Pages Deploys

Decision: The MOS public site (`site/`, landing page + docs) replaces the preserved MOS1 site as the deployed source for `myownsuite.org`. Deployment moves from Cloudflare Pages git-integration builds to GitHub Actions direct upload: `.github/workflows/deploy-site.yml` builds `site/` from a clean install and runs `wrangler pages deploy` on pushes to `main` (production) and `staging` (aliased preview) only. No other branch deploys, and the Pages project's own git-integration builds must stay disabled so the workflow is the single deployment path. Root `npm run build` and `wrangler.toml` (`pages_build_output_dir = "site/dist"`) now target `site/`; the MOS1 reference site is no longer built in CI and `site-mos1-reference/` remains only as frozen reference content. The workflow authenticates with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

Reason: The rebuilt MOS site is good enough to replace the MOS1 story the live site was still telling, and building in required CI before deploying removes the failure mode where the launch surface breaks only inside Cloudflare's build environment. Restricting deploys to `main` and `staging` keeps feature branches from publishing previews of unreviewed content.

Consequences:

- This supersedes the public-site continuity part of the 2026-07-11 decision below; the MOS1 site is retired from CI and deployment.
- Rollback path: revert the deploy workflow, `wrangler.toml`, and root build script in one commit to restore the previous MOS1 deployment contract (and re-enable the Pages git integration if reverting all the way to dashboard-driven builds).
- The `MOS Site` CI job stays required on every branch; the deploy workflow additionally gates deployment on its own clean build.
- Cloudflare credentials live only in GitHub repository secrets, never in the repo.

## 2026-07-11: Post-Cutover Repo Hygiene And Public Site Continuity

Decision: `AGENTS.md` is the single tool-agnostic agent instruction file; `CLAUDE.md` exists only as a loader pointer for Claude Code, and tool-specific rule folders (`.codex/`, `.agents/`, `.clinerules/`) are removed. The deployed public site keeps building from the preserved MOS1 source: `site-mos1-reference/` embeds frozen MOS1 technical reference copies under `src/reference/` (taken from `archive/mos1-main-snapshot`) instead of reading live `apps/` packages, root `npm run build` builds it, and Cloudflare Pages output is `site-mos1-reference/dist`. Release metadata guardrails (`npm run release:check`) cover root `VERSION` and `releases/stable.json` only until MOS gains stable release-track managed updates.

Reason: The cutover left agent rules split across tool-specific folders, silently broke the public site build by making MOS1 docs import MOS package READMEs (or removed paths), and dropped the `hooks:install`/`release:check` guardrails that root docs still referenced. The public site documents the latest published release, which is still MOS1, so it must stay buildable and deployable without depending on removed MOS1 runtime paths.

Consequences:

- New hard agent rules go to `AGENTS.md`; durable working context goes to `docs/codex-notes.md`; no new tool-specific rule folders.
- The MOS1 site is content-frozen: factual fixes only, no new product docs; the MOS public site rebuild happens under `site/`.
- CI runs the MOS workspace checks, the release metadata check, and the preserved public site build; paid/destructive smoke and full E2E remain human-run.
- A Suite Manager release metadata file returns, with `release:check` coverage, when MOS stable-track managed updates land.

## 2026-07-10: MOS Replaces MOS1 As The Default Repository Layout

Decision: MOS is the default root layout. The former isolated workspace has moved to root-level `suite-manager/`, `apps/`, `system-agents/`, `infrastructure/`, `scripts/`, `shared/`, and `test/` paths. The old MOS1 root shape is preserved on `archive/mos1-main-snapshot`; the old public site source remains in `site-mos1-reference/` only as reference while the MOS public site/docs are rebuilt later.

Reason: MOS is now validated enough to replace the isolated lab shape, and there are no external MOS1 users whose migration blocks the repo default. Keeping MOS in a nested workspace would make installers, managed updates, docs, package paths, and contributor behavior keep carrying a temporary architecture.

Consequences:

- New development should target the root MOS layout and `staging` integration branch.
- Installed bootstrap/update/reconciliation paths use `/opt/mos/repo/...`.
- App runtime build contexts use `apps/<app-id>`.
- Root npm commands such as `npm test`, `npm run build:client`, and `npm run install:render` operate directly on the active workspace.
- MOS1 runtime code is not kept in the active root layout; use the archive branch for recovery or reference.
- Public landing page and end-user docs cleanup is deliberately deferred from the functional cutover.

## 2026-07-08: MOS Homepage URL Reconciliation Is Metadata-Scoped

Decision: MOS Homepage URL reconciliation is driven by MOS metadata, not by blind URL search/replace. Plain user-authored links remain untouched. MOS catalog app tiles are updated only when their stable Homepage entry ID matches an installed app instance. Non-catalog LAN/home-service tiles are updated only when they carry structured `mos.proxy` metadata, which regenerates the public URL and Caddy route from the current domain state.

Reason: Homepage can intentionally contain unrelated internet shortcuts, MOS-owned app package shortcuts, and user-managed LAN apps exposed through MOS HTTPS. DNS/domain changes should repair the two MOS-managed classes without corrupting arbitrary links that happen to use old domains or HTTP.

Consequences:

- App package routes and Homepage customization routes remain separate generated outputs.
- HTTPS/DNS-01 apply may trigger app runtime route reapply and Homepage projection reconciliation, but it must not rewrite unannotated links. Homepage/home-service reconciliation runs as its own phase, and per-app runtime failures are reported as partial reconciliation instead of silently turning HTTPS apply into a misleading success.
- Catalog app widget URLs follow the app's current public URL when the tile is MOS-owned by app instance ID.
- Home-service proxy routes follow `mos.proxy` metadata and current domain state; the source Homepage template remains the user-facing ownership document.

## 2026-07-04: MOS App Integrations Use Capability Relationships

Decision: MOS models optional app-to-app integrations as capability relationships between independently installable packages. A provider package exports a capability, a consumer package imports a compatible capability, and Suite Manager records an explicit relationship with its own lifecycle, projections, and redacted secret grants. ONLYOFFICE is an independent document-editor provider; Seafile is one compatible document-platform consumer, not the parent package.

Reason: Seafile plus ONLYOFFICE is the first concrete case, but the architecture should also fit future file platforms, SSO providers, SMTP providers, object storage, backup targets, databases, caches, and media helpers. Bundling ONLYOFFICE into Seafile would make Seafile heavier and would hardcode one app pair into the product model.

Consequences:

- Suite Manager may render generic compatibility and "connect" actions, but production core must not hardcode Seafile/ONLYOFFICE-specific environment names or app pair logic.
- Integration state must be separate from each app's install state so one provider can serve multiple consumers and one consumer can degrade cleanly if a provider is disabled.
- Shared integration secrets are grants, not arbitrary cross-app secret reads. They must stay out of public APIs, logs, projections, and broad SQLite rows.
- Provider or consumer route/secret changes must make affected relationships require reapply or revalidation.
- Provider/consumer lifecycle actions must update relationship state truthfully and reapply or revalidate compatible active relationships where safe.
- Capability-provider and companion packages may omit Homepage contributions; Suite Manager should present them as integration services rather than ordinary app destinations.
- Complex pair-specific glue may be introduced later only through a reviewed package-owned contract, not arbitrary frontend code or broad shell hooks.

## 2026-07-05: MOS Managed Updates Use A Narrow Host Agent And Reconciliation Script

Decision: MOS managed updates are requested from Suite Manager but applied by a root-owned `mos-update-agent` over a local Unix socket. The first supported apply path is branch-track updates for MOS lab and Hyper-V validation. The update worker fetches and fast-forwards the configured branch, installs MOS dependencies, rebuilds Suite Manager frontend assets, and runs `scripts/reconcile-system.cjs` to refresh repo-owned systemd units, host agents, Caddy override/binary wiring, socket directories, and control-plane service restarts.

Reason: This preserves the successful V1 model where the web app communicates intent while a host-owned updater applies infrastructure changes. MOS has more separated agents than V1, so the refresh path must reconcile all repo-owned host services instead of only recreating a Compose stack.

Consequences:

- Suite Manager must not run git, npm, Docker, Caddy, or systemctl update commands itself.
- The update agent API stays narrow: status, start update job, read job state, and configure track.
- The update result may report core reconciliation success while installed app runtimes are preserved and marked for manual reapply/restart after package Dockerfile or manifest changes.
- A later updater slice should add package-aware runtime reconciliation so changed installed app packages can be rebuilt/reapplied automatically without weakening app data that still belongs to installed or stopped apps.
- Stable release-track polish can reuse the same agent boundary, but branch-track updates remain the practical validation path until MOS release metadata is finalized.

## 2026-07-03: MOS App Packages Own Runtime Shape And Lifecycle

Decision: MOS app packages are self-contained folders under `apps/<app-id>/` that declare metadata, setup fields, services, routes, Homepage projections, health checks, widgets, onboarding, and capabilities. Suite Manager persists app instance/config/projection/operation state in SQLite and asks a narrow app agent to apply Docker, Caddy, and health changes. Runtime state supports health refresh, disable, re-enable, restart, and destructive uninstall.

Reason: V1 scattered app-specific behavior across Compose files, env generation, Caddy generation, onboarding, doctor scripts, and Suite Manager UI. MOS needs adding an app to mostly mean adding a package folder, while keeping privileged host actions out of the web process.

Consequences:

- App-specific code and Dockerfiles belong in the package folder; Suite Manager core and host agents operate on validated generic projections.
- Generated infrastructure must be reproducible from package manifests plus persisted app/relationship state.
- Secrets use redacted references in normal state and are materialized only for narrow runtime apply operations.
- App routes remain separate from Homepage customization routes.
- Stop/disable is the non-destructive pause action: it removes runtime containers but keeps app routes, Homepage shortcuts, volumes, config, and secrets so the app can be started again.
- Uninstall is the destructive removal action: it removes runtime containers, package routes, MOS-owned Homepage shortcuts, package Docker volumes, Suite Manager app instance/config/projection state, app secrets, and app integration rows so the catalog returns to a fresh installable state.
- If MOS later needs an archive-data workflow, it should be a separately named action instead of overloading uninstall.

## 2026-07-02: MOS App Setup Guides Are Declarative And App-Scoped

Decision: MOS app packages may declare post-install setup guides in their manifest `onboarding` metadata. Suite Manager renders those guides generically from declarative sections such as copyable non-secret values, notes/warnings, device/client choice guides, ordered steps, and manual completion actions. Guide state is stored per app instance in SQLite as viewed, completed, or skipped, and completed/skipped guides stay quiet while remaining available from the app detail view.

Reason: Some apps are technically running after install but still need human setup in an external client or device. Radicale is the proving case: Suite Manager can show CalDAV/CardDAV server details and device instructions without hardcoding a Radicale React page or trying to automate each client. This keeps app-specific help attached to the installed app instead of polluting global owner onboarding.

Consequences:

- Package guide metadata must remain declarative; package manifests must not include arbitrary JavaScript, shell commands, database queries, or app-specific React components.
- Guide values may interpolate app public URLs and non-secret config values. They must not reveal or copy raw secrets; secret fields should be explained as user-entered or app-native values.
- Suite Manager persists guide state per app instance, not in the old global onboarding state.
- App-native onboarding remains app-owned when it is good enough. Suite Manager should guide the owner only where MOS can add clear contextual value.
- Richer guide capabilities such as per-section progress, secret reveal, app-specific observers, or custom components require a separate reviewed contract.

## 2026-06-20: MOS HTTPS Is Applied By A Narrow Host Agent

Decision: MOS configures post-install HTTPS from authenticated Suite Manager Settings, but a dedicated root system agent owns Cloudflare token storage and Caddy mutation. MOS builds a pinned Caddy binary with `caddy-dns/cloudflare`, stores only non-secret HTTPS state in SQLite, retains the installer-created HTTP Home host for recovery, and uses `home.<base-domain>` as the configured HTTPS origin.

Reason: Stock Caddy packages do not contain the external Cloudflare DNS provider, while the web process must not gain general host privileges or persist DNS credentials in ordinary application state. Keeping the existing origin live during a transactional apply also lets Suite Manager report the new URL without restarting itself mid-request.

Consequences:

- Bootstrap and managed updates must reproducibly rebuild, verify, install, and select the MOS-owned Caddy binary.
- The HTTPS agent exposes only structured status/apply/commit/rollback operations over a restricted Unix socket; it is not a general host shell or DNS manager.
- Cloudflare credentials live only in a root-owned secret environment file and must never appear in SQLite, generated Caddy text, public APIs, logs, or diagnostics.
- Candidate Caddy configuration is validated, atomically installed, reloaded, and rolled back on failure before Suite Manager records it as active.
- The configured HTTP Home host redirects to HTTPS, while the original authenticated HTTP bootstrap host remains available for transition and recovery.
- Host-only sessions are not transferred between origins; users sign in again and HTTPS responses set `Secure` cookies.

## 2026-06-19: MOS Homepage Is Authenticated Through Suite Manager

Decision: MOS exposes one `home.<domain>` control-plane origin through Caddy. Suite Manager owns `/suite-manager/`, authenticates the shared origin, and proxies all other authenticated paths to the private loopback Homepage service. Sessions remain host-only; MOS does not share a parent-domain session cookie across app subdomains.

Reason: Suite Manager already owns owner identity and sessions. Keeping Homepage behind it avoids duplicating session validation in Caddy and prevents a direct public bypass, while host-only cookies keep MOS credentials away from future independently authenticated apps.

Consequences:

- Home serves Suite Manager onboarding/login/account controls at `/suite-manager/` and the authenticated Homepage dashboard at `/`.
- Caddy has no direct Homepage upstream; Homepage binds only to loopback.
- Dashboard and Suite Manager share one browser session without exposing that credential to future app subdomains.
- Suite Manager must preserve streaming, redirects, forwarded headers, and WebSocket upgrades while removing its session cookie before proxying Homepage.
- Homepage runtime files are seeded into durable state; `services.template.yaml` is the future editor-owned source and `services.yaml` is its generated stock-Homepage projection.

## 2026-06-18: MOS Restarts From A Suite Manager-First Lab

Decision: The MOS app platform work restarts from a clean branch based on `staging`, with new implementation isolated in a temporary workspace. The first milestone is not app catalog expansion; it is a reliable control-plane install and Suite Manager browser-based owner creation flow. The existing repo code and the previous app catalog prototype branch remain reference material for lessons and selective future extraction, not code to run through or merge wholesale.

Reason: The prototype proved important concepts, but it also mixed old preloaded-suite assumptions with new launch-platform behavior across many files. Starting with a narrow Suite Manager-first lab lets MOS design the new platform around first-run ownership, testability, and clean package boundaries before optional app lifecycle code biases the foundation.

Consequences:

- Installer and DigitalOcean validation work should prove that owner credentials can move from installer input to browser setup.
- Optional app package work waits until the Suite Manager install and first-run owner flow are trustworthy.
- Existing Suite Manager UI primitives should be reused for the owner setup experience.
- The temporary workspace is the home for new platform code until MOS is proven; existing `apps/`, `scripts/`, `deploy/`, and `agents/` code should be treated as old-system reference material unless explicitly copied or rebuilt into MOS.
- The MOS workspace may keep temporary planning docs while active, but durable architecture belongs here and task state should move to GitHub Issues before merge.

## 2026-06-11: Alpha Moves Toward Control-Plane-First App Catalog Installs

Decision: Fresh MOS own-infra installs should move toward installing only the control plane by default: Suite Manager, Homepage, Caddy, and required host agents. The owner should create the MOS account in Suite Manager on first browser visit, then choose apps from a Suite Manager-managed catalog. App installation should update the repo-owned Compose generation, Homepage YAML, Caddy generated config, env files, and app-specific setup helpers as needed.

Reason: The current preloaded-suite model forces installer-time owner credentials because some apps need user seeding during bootstrap. That makes USB and cloud installers harder to align and makes fresh installs feel more opinionated than necessary. A catalog model lets MOS install the machine runtime first, then let the owner decide which apps to add and what credentials each app should use.

Consequences:

- Installer front doors should stop requiring owner email/password once Suite Manager first-run owner creation and app catalog provisioning are ready.
- Suite Manager becomes the friendly control plane for Homepage YAML, generated Caddy config, selected app services, app env files, and app-specific setup flows.
- Existing onboarding logic should be split into suite-level owner setup and app-specific install/setup helpers.
- Fresh installs can become lean by default, while existing installs should be migrated conservatively and never have apps removed automatically.
- The catalog needs a repo-owned manifest/contract for app metadata, Compose participation, routes, Homepage defaults, volumes, provisioning mode, backup behavior, and lifecycle actions.
- The old alpha plan has been superseded by the compact MOS lab plan and durable MOS decisions in this file; task state should move to GitHub Issues before merge or release.

## 2026-06-08: Own-Infra Is One Self-Hosted Runtime

Decision: MOS will treat VPS/cloud-machine installs and own-hardware installs as one self-hosted own-infra runtime. The supported runtime target is Ubuntu Server 24.04 LTS plus the repo-owned Docker Compose stack, host agents, Caddy routing, managed updates, backups, restore, and customization workflows. USB and cloud-machine setup are installer front doors for the same runtime, not separate deployment systems.

Reason: Maintaining separate VPS, local, and USB/self-host paths creates painful testing overhead without matching user value. The existing USB bootstrap already delegates env generation, validation, and stack startup to the shared Compose tooling, while host-only features are capability-gated through local agents. A single own-infra standard lets the project spend effort on one robust path.

Consequences:

- Public deployment choices should collapse toward Platform and Self-hosted.
- Platform deployments currently mean Railway and remain useful for simple trials, referral/commission revenue, and hosted exposure, but they should not drive host-owned backup/update feature design.
- Self-hosted installs should behave the same on own hardware and cloud machines after first boot.
- Cloud-machine support should use provider-agnostic Ubuntu 24.04 cloud-init/user-data, not source changes per hosting provider.
- The existing `deploy/vps` tooling is best understood as the local/development and own-infra Compose substrate until filenames can be renamed safely.
- The abandoned Cloudflared tunnel direction should be deprecated unless a future issue reopens it with a clear need.

## 2026-06-06: Local HTTPS Uses Caddy DNS-01 And Explicit Homepage URLs

Decision: Self-host local HTTPS uses Caddy-owned ACME DNS-01 automation with scoped DNS-provider credentials in Caddy env, while Suite Manager owns validation, status, and narrow apply orchestration. Homepage external-service `href` values remain concrete browser URLs. MOS may regenerate those URLs only for Suite Manager-managed tiles that carry structured `mos.public.mode: app-subdomain` metadata, or after an explicit user-confirmed conversion.

Reason: Real install testing confirmed that Cloudflare DNS-01 works for private LAN hostnames without public app A/AAAA records, and that built-in MOS routes can move from `mos.home` to a real domain cleanly. The same test also showed that manually authored Homepage links can intentionally contain any domain, so blindly replacing `*.mos.home` or `http` strings would risk corrupting user-owned config.

Consequences:

- Caddy owns certificate issuance and renewal; Suite Manager and host agents do not run renewal jobs.
- The self-host service agent may expose a narrow local HTTPS apply capability, but it must not become a general host shell, DNS manager, or certificate manager.
- `href` and `mos.proxy.upstream` must stay visually and conceptually distinct in Suite Manager UI.
- Explicit/user-authored Homepage links are not automatic migration targets when `DOMAIN` or `PUBLIC_URL_SCHEME` changes.
- Clean-install UX should make the correct first-time path easy instead of accumulating migrations for one historical development server.

## 2026-06-01: Homepage YAML Is The Service Layout Source

Decision: Homepage YAML remains the user-facing source of truth for dashboard layout, service grouping, tile order, names, descriptions, icons, widgets, and visibility. MOS will not introduce a separate full service-registry document as the first source of truth for service/dashboard/proxy configuration. Instead, MOS may add small optional `mos` annotations to Homepage service tiles for metadata that Homepage does not model, starting with external-service proxy details for generated Caddy config.

Reason: Homepage and Caddy are established, documented tools that technical users can already configure directly. A new proprietary registry would be easier for MOS internals but harder for users to recognize, search, copy, and ask tools for help with. Keeping Homepage YAML as the layout document lets Suite Manager build friendly add/edit flows later without rebuilding the whole Homepage dashboard editor.

Consequences:

- Homepage owns advanced dashboard layout.
- Suite Manager should manage common service workflows and safe subsets of config, not become a full interactive Homepage layout clone.
- Caddy generation should read explicit `mos.proxy` annotations from Homepage tiles instead of raw Caddy snippets or a separate MOS registry.
- External services are metadata-only from MOS's perspective; integrated apps remain distinct because MOS owns their lifecycle.
- Generated Caddy config must be previewed and validated before any future apply/reload path.
- Existing static Caddy routes and default domain behavior must remain compatible during migration.

## 2026-05-29: Homepage Config Is Suite Manager-Owned

Decision: Homepage remains YAML-first, but persisted runtime customization is owned by Suite Manager. Homepage fetches an allow-listed config export from Suite Manager during container startup, writes it into its local config directory, then runs the existing `services.template.yaml` to `services.yaml` generator before starting the stock Homepage server.

Reason: Railway does not support sharing one persistent volume between services, and build-time fetching cannot rely on private service networking or persist generated files into runtime state. Startup sync keeps Homepage close to stock, avoids dirty source checkouts, and lets Suite Manager own the editor, storage, reset, and export API.

Consequences:

- Suite Manager stores editable Homepage YAML/CSS/JS under its own persistent state directory.
- Homepage does not require a persistent config volume for customization.
- `services.yaml` remains generated output and is not user-editable.
- Runtime config changes apply after Homepage restarts and fetches the latest Suite Manager export.
- The Homepage-to-Suite-Manager export uses a shared private bearer token.

## 2026-05-30: Self-Host Host Agents Are Repo-Reconciled

Decision: USB self-host installs should keep first-boot responsibilities small and let the repo reconcile host-side agents after checkout. Host agents live under `agents/selfhost/`, and `system:migrate` may install or refresh them on machines marked as self-host.

Reason: New service, backup, restore, monitoring, update, and proxy-management capabilities should not require reflashing the USB installer. The installer should install the OS, baseline tools, repo checkout, and initial settings; the repo should own ongoing app and agent setup.

Consequences:

- Existing self-host machines can gain new host agents through managed updates or a root-run repo migration path.
- Suite Manager should prefer capability detection from reachable agents over broad platform-mode flags.
- Agent APIs must stay narrow, local-only, and token-protected because they perform host-level actions.
- Fresh bootstrap and managed updates should share the same host-agent reconciliation path.

## 2026-05-30: Offline Backups Are Host-Owned

Decision: Offline suite backups use a host-owned `mos-backup-agent`. Suite Manager talks to it over a token-protected local Unix socket, and the container only receives the socket and token file mounts.

Reason: Whole-suite snapshots need host visibility into mounted external drives and, later, Docker volumes and stack lifecycle. That control should stay in a narrow host agent instead of broadening Suite Manager container privileges.

Consequences:

- Suite Manager enables backup actions only when the backup agent is reachable and advertises the needed capability.
- External backup destinations are detected by the host agent, initially under `/media`, `/mnt`, and `/run/media`.
- Restore remains version-paired and conservative until the backup bundle format is validated on real self-host hardware.

## 2026-04-28: Self-Host Updates Are Host-Managed

Decision: The Suite Manager container must not update the host directly. Self-host installs use a host-owned `mos-update-agent` systemd service, and Suite Manager talks to it through a controlled local API.

Reason: This matches the Railway and Home Assistant Supervisor pattern: the app can request an update, but infrastructure applies it. It keeps host control out of the web container while still enabling a friendly in-app update action.

Consequences:

- Hosted or agent-less deployments show manual/notify guidance.
- Self-host deployments expose managed update actions only when the update agent is installed, reachable, and advertises the needed capability.
- Host-side updater changes need an explicit self-refresh path so future systemd/agent improvements do not require reflashing.

## 2026-04-28: Update Agent API Is Local-Only

Decision: Managed self-host updater actions use a Unix socket plus shared bearer token. They must not expose an HTTP port on the LAN or internet.

Reason: The updater has host-level effects. Keeping the transport local-only sharply reduces accidental exposure while still allowing Suite Manager to request controlled actions through a mounted socket.

Consequences:

- Self-host Compose mounts `/run/mos-update-agent` into Suite Manager.
- Suite Manager only enables managed apply actions when the configured local agent is reachable.
- Any future remote-management feature needs a separate security design.

## 2026-04-28: Branch Tracks Are For Hardware Testing

Decision: Stable installs should follow releases. Non-main self-host installs can follow a configured branch track, especially `staging`, for hardware testing before release.

Reason: The project needs real-machine validation without publishing official releases just to test branch work.

Consequences:

- USB installer config supports `REPO_REF`, `UPDATE_TRACK`, and `UPDATE_REF`.
- Test machines can subscribe to `staging`.
- The Updates UI should clearly show the active track.

## 2026-04-30: System State Changes Have Two Update Tracks

Decision: Runtime `.env.template` files describe the latest supported app contract. Managed-platform deployments keep their environment variables and infrastructure state user-owned and should fail clearly when required variables no longer match the current contract. Repo-managed VPS/self-host installs use an explicit `system:migrate` phase before `vps:init` so known historical state changes can be repaired without asking the user to SSH into generated files.

Reason: Railway-like platforms already provide an env-var UI and the project cannot safely mutate platform resources. Own-infra installs have no friendly platform UI, so the repo must own small, named migrations for compatibility breaks while keeping `vps-init` focused on rendering the current templates.

Consequences:

- New app env requirements belong in the relevant `.env.template` and technical README first.
- Historical compatibility fixes for own-infra installs belong in `scripts/migrations/`, not inline in `scripts/vps-init.cjs`.
- Migrations must be idempotent and preserve existing secrets instead of generating replacements for already-provisioned services.
- System migrations may repair env files, generated service config, local state files, directory layout, or other repo-owned own-infra state.
- Managed-platform compatibility problems should point users at the current template/README rather than silently rewriting platform variables.

## 2026-04-28: GitHub Issues Hold Task State

Decision: GitHub Issues are the source of truth for task-level work, backlog, and roadmap-like planning. Repo docs hold durable architecture decisions, project workflow rules, and working context that should still matter after an issue is closed.

Reason: Issues and PRs are where Codex, humans, code review, and status all meet. Repo docs are better for context that should survive issue closure.

Consequences:

- Do not keep long-lived task lists or roadmap documents in repo docs.
- Temporary branch plans are allowed only while actively useful and should be removed or replaced before merge.
- Use `.github/ISSUE_TEMPLATE/codex-task.yml` for Codex-ready tasks.
- Use `docs/decisions.md` for architecture decisions and `docs/codex-notes.md` for durable working context.
## 2026-07-13: App Packages Are Independently Versioned Source Snapshots

Decision: MOS platform releases, MOS app-package releases, and upstream app versions are independent. The repository contains the latest official package source, while each installation preserves the exact package snapshot it installed or last updated: manifest/setup schema, runtime assets, source revision and digest, component identities, and privacy review. Normal management renders from the installed snapshot; a fetched candidate is used for update comparison until successfully applied. Official and external sources share this source-addressed package contract with explicit trust levels.

Reason: Apps need frequent security and feature updates without forcing MOS platform releases. Installed settings and privacy claims must continue to match the running package even after the source publishes a newer candidate. Preserving a bounded local snapshot provides that truth without maintaining a permanent public archive of every historical package. The same source contract also enables future manually added community packages without confusing structural validity with MOS review.

Consequences:

- App-package versions advance independently and declare their minimum compatible MOS platform version.
- Installed settings, lifecycle, backup metadata, and privacy posture come from the installed snapshot, not the moving repository checkout.
- Update discovery periodically fetches a small source catalog, resolves a candidate through an immutable revision, verifies its digest, and compares it with installed state before apply.
- Unknown or stale privacy evidence yields `review-required`; assessments bind to exact package/component identities and configuration is not described as proof of network silence.
- A lightweight advisory can invalidate installed assessments without retaining complete historical packages in the source repository.
- Unverified packages must remain visibly unverified and operate under a constrained capability contract because installing package code is a privileged action.
- Installed, candidate, and bounded previous package snapshots live under `/var/lib/mos/app-packages` (or `<MOS_STATE_ROOT>/app-packages`). The root app agent owns writes; Suite Manager receives read access through `mos-agent`. The root is provisioned as `root:mos-agent` mode `2750`, while snapshot transaction directories may be stricter. Group read is load-bearing rather than incidental: Suite Manager re-verifies snapshot identity and digest on every read, so it reads these files directly and a snapshot it cannot read is an unusable app. The group is therefore established twice — the root carries setgid so anything created below inherits it, and the agent sets it explicitly on each snapshot tree rather than relying on inherited state, because a root recreated by a restore carries neither the bit nor the group. Directories a privileged process creates do not otherwise inherit the parent's group, so provisioning only the root leaves every snapshot below it unreadable.
- Initial snapshot creation accepts only an instance UUID, package id, and expected digest. The app agent derives the official source and destination from configured roots, copies only contract-approved regular files into a sibling transaction directory, verifies the copied digest, and atomically promotes it without replacing an existing installed snapshot. Update staging additionally accepts Suite Manager's candidate path, but only beneath the agent's separately configured private candidate root; it binds the expected installed digest and candidate digest, independently re-verifies both trees, then copies the candidate into the agent-owned instance directory. Arbitrary host paths remain outside the capability.
- New installs must complete that validated snapshot operation before writing setup secrets, configuration rows, or runtime projections. Until catalog fetching supplies a resolved Git commit, the canonical package digest is also stored as the immutable content revision; later fetches may store the verified Git commit while retaining the package digest as the content identity.
- Runtime apply identifies the installed package only by instance UUID, package id, and package digest. Suite Manager validates and renders from its recorded snapshot, while the root agent independently derives the snapshot directory beneath its configured root and re-verifies the manifest id and digest before building. Runtime requests never provide a host build-context path.
- Locally built images and running containers carry exact package-version, package-digest, and source-revision labels. Their deterministic image tags include the package version plus short digest and source-revision fragments for operator readability; the full labels remain authoritative.
- Once an instance has an installed snapshot, catalog details, setup guides, icons, lifecycle projections, and integration declarations are read from that verified snapshot. Repository discovery contributes only not-yet-installed candidates; removing or advancing the checkout does not reshape an installed app.
- Existing app rows enter `legacy-unmigrated` snapshot state with null source, digest, and privacy identity. A later migration may promote them only after matching the stored manifest digest/package version to validated package contents; otherwise they become `needs-package-recovery` rather than inheriting current repository claims.
- Suite Manager runs that legacy-package migration before opening its listener. A matching package is copied through the same narrow atomic snapshot operation as a new install; missing or mismatched source becomes `needs-package-recovery`, while transient agent failures remain retryable and do not invent recovery evidence.
- Whole-suite backups include the installed package-snapshot root and enumerate each instance's source identity plus every snapshot file's size and SHA-256 hash. Restore verifies the manifest, state archive, volume archives, package identity, and snapshot payloads before stopping services, restores snapshots with Suite Manager state, and only then reconciles runtimes from those snapshots.
- A valid package snapshot preserves MOS configuration and build instructions, not third-party registry availability. If an immutable upstream base image has disappeared, restore keeps the recovered state and restarts the control plane but reports the app-runtime reconciliation failure; MOS does not silently substitute a newer artifact.
- Package source trust is derived by MOS from the configured source and verification path. Package-controlled metadata cannot promote an external source to `mos-reviewed`.
- Official catalog refresh defaults to every six hours with 10% jitter; advisories refresh hourly. Failures use exponential backoff from five minutes to six hours and preserve the last-known-good cache, which is labelled stale after 24 hours rather than deleted. Manual Refresh may bypass freshness/backoff but is rate-limited to one attempt per 30 seconds and never clears usable cached data on failure.
- Official catalog reads resolve the configured GitHub branch through the GitHub API, validate its full commit SHA, and fetch `apps/catalog.json` from the raw-content URL for that exact commit. Redirects, credentials in source URLs, non-GitHub official origins, oversized responses, invalid catalogs, and same-version/different-digest candidates fail closed. Cache and API status may report fetch failure while continuing to serve the last verified catalog and all installed snapshots.
- Update preparation is a read-only transaction. Suite Manager downloads only revision-bound GitHub package entries into a private bounded candidate directory, verifies the full canonical package digest before parsing runtime/build inputs, compares it with the installed snapshot, and deletes the candidate after producing the preview. Structural breaking changes require matching manifest declarations; newly required secrets remain browser-local until a later confirmed apply transaction.
- The app-agent package-update contract includes staging. Staging does not replace the installed snapshot or touch running containers; it establishes the agent-owned, digest-bound candidate required for a later transactional build/apply operation and fails with an identity-changed conflict when either side no longer matches the previewed identities.
- Confirmation is not authorization to apply an arbitrary previously downloaded directory. Suite Manager re-downloads the immutable candidate, repeats structural/privacy/compatibility comparison, and requires the resulting digest-pair token to match before asking the agent to stage it. SQLite records one active update operation per app with the expected installed digest, candidate digest, and latest durable stage; interrupted `candidate-staged` and `candidate-built` operations are therefore distinguishable from both an installed update and an unverified download after restart. The contract-version-3 app agent builds all candidate images from its own re-verified candidate snapshot before any container, route, volume, or installed identity is changed. Build requests remain structured runtime projections, are bound to both installed and candidate digests, and are never persisted because their materialized environment can contain secrets.
- App-agent contract version 4 adds a deliberately lower-level candidate-activation primitive. It accepts only a pair of fully validated structured runtimes whose instance, package, and installed digest identities agree; re-verifies both agent-owned snapshots; reuses deterministic named volumes; starts and health-checks the candidate; and changes the package Caddy block only after health succeeds. Any activation or route failure removes the candidate runtime and restarts plus health-checks the installed image. A failed rollback is reported separately. Suite Manager must not call this primitive as a completed update until it can also reconcile cross-app networks, promote snapshots, and commit database identity as one recoverable operation.
- App-agent contract version 5 adds digest-bound snapshot promotion after candidate activation. Suite Manager now advances an update through candidate build, candidate health, cross-app network reconciliation, conditional Homepage reconciliation, agent-owned snapshot promotion, and one SQLite identity/projection commit. Promotion uses same-filesystem renames, re-verifies both package digests, and retains exactly one prior snapshot only when the candidate declares rollback `safe`; otherwise the displaced definition is removed after promotion. Deterministic named volumes remain attached across the runtime replacement. An app that was not on Homepage stays absent; an applied stable-ID entry is atomically replaced from the candidate projection and restored if later promotion or persistence fails, with its applied state carried into the candidate database projection. Failures retain the latest durable operation stage, including the explicit case where the candidate is healthy but integration, Homepage, or post-promotion database recovery is still required. Automatic startup recovery remains required before Phase 5 can be considered fully transactional.
- App-agent contract version 6 adds explicit identity-bound runtime rollback. Any orchestration failure after successful candidate activation but before snapshot promotion asks the root agent to remove the candidate containers, restart and health-check the installed snapshot's containers on the same deterministic named volumes, and restore its Caddy route. A rollback failure is distinct from the triggering failure. Suite Manager startup closes any operation left `running` and persists an app-visible recovery classification: pre-activation stages are `retry-safe`, post-activation stages are `rollback-required`, and post-promotion stages are `commit-required`. Migration descriptions remain owner-visible instructions rather than executable shell hooks; MOS preserves named volumes and integration rows, never deletes displaced data during update, and blocks undeclared structural breaks. Since core checkout changes no longer reshape or rebuild installed snapshot-bound apps, the core updater no longer asks owners to reapply app runtimes.

## 2026-07-12: Public Installer Uses Stable And Development Channels

Decision: One Cloudflare Worker implementation serves two public installer channels. `get.myownsuite.org` tracks `main` for released installs, while `get-dev.myownsuite.org` tracks a Worker-configured development branch. Each request resolves the branch tip through GitHub, validates a full commit SHA, and generates an installer pinned to that immutable commit. Cloud-machine smoke harnesses use the development URL by default.

Reason: Release users need a stable entry point, while Hyper-V and DigitalOcean validation need to follow active branch work without manually redeploying a Worker or maintaining a separate installer implementation.

Consequences:

- The stable Worker sets `INSTALL_BRANCH=main`; the development Worker sets it to the branch under test and can later switch to `staging`.
- The public repository requires no GitHub credential for branch resolution and no Cloudflare token at installer request time.
- A branch may move between requests, but every individual installation is pinned to and verifies one exact resolved commit.
- Stable installer validation remains a release gate after changes reach `main`; development harnesses continuously exercise the same installer contract beforehand.

## 2026-07-15: External App Packages Are Published Via A `.mos/` Folder

Decision: A third party publishes an app package to MOS by committing a `.mos/` folder (manifest, icon, Dockerfiles, declared runtime assets) to the root of a public git repository. MOS identifies an external package by its repository URL alone — one repository is one app — and the package id is read from the downloaded manifest, never from the URL. Git hosts are restricted to an allowlist; only `github.com` is enabled to begin with, with `gitlab.com` and `codeberg.org` reserved as future descriptor entries. Package content is fetched provider-neutrally: MOS resolves the repository ref (or default branch) to an immutable commit, downloads a gzip repo archive at that commit, and extracts only `.mos/` through a hardened tar reader before the existing digest, constrained-capability, and non-impersonation gate runs.

Reason: Publishers should not have to fit a MOS-specific catalog layout or hand MOS a fragile deep link into a subfolder; a conventional root `.mos/` folder mirrors `.github/` and makes the shareable identifier just the repository URL. A host allowlist plus revision-pinned archive download removes arbitrary/credentialed URL surface, and a single archive path keeps multi-host support to a small per-host descriptor rather than three content-API integrations.

Consequences:

- Owners preview an external app by pasting a repository URL into the Apps search; MOS resolves and validates it into an external, unverified app card (with the package's own icon) and persists nothing until the owner installs. Clearing the URL removes the card.
- External sources use the fixed `.mos` catalog path and are `unverified`; they can never be `mos-reviewed`, and the impersonation guard still blocks reuse of official ids, reserved prefixes, or self-asserted review. `publisher-signed` remains a reserved storage/schema value for a future publisher-key design but is refused until MOS can verify it.
- Archive extraction fails closed on symlinks, hard links, devices, extended headers, path traversal, absolute paths, multiple roots, missing manifests, and file/byte-count overruns, and materializes only `.mos/` as the package directory.
- The download/extract pipeline is host-agnostic; enabling GitLab or Codeberg later is one `HOST_DESCRIPTORS` entry (repo-info, ref→commit, and direct archive URL) plus tests. Nested GitLab subgroups and non-allowlisted hosts are rejected at URL parse time.

## 2026-07-15: External App Installs Are Isolated By A Namespaced Package Identity

Decision: An external package is installed under `x-<source-namespace>-<manifest id>`, not the id its manifest claims, and every MOS-side name derived from the package keys off that installed id: the `app_instances` row, the build context, loopback ports, container/volume/network names, and the Caddy route block. The app agent gains one narrow capability for this, `apps.package.snapshot.external` (app-agent contract version 7), which snapshots a downloaded candidate rather than a repository folder. It accepts a candidate only from inside the host-owned candidate root, only at the package digest Suite Manager already validated, and only under a namespaced id whose suffix equals the candidate's own manifest id. External candidates therefore download into the same `app-candidates` root the official update flow uses. Route hosts stay first-come: an install is refused if a declared web address is already served by an installed app.

Reason: `app_instances.package_id` is unique and every runtime name is derived from it, so a bare manifest id would let two repositories publishing the same id collide, and would let an external package occupy an official app's runtime identity. Namespacing at install makes isolation structural rather than a validation rule that has to be remembered at each call site. Enforcing the namespacing rule inside the agent as well means the boundary holds even if Suite Manager asks for the wrong thing, which is the same reason the agent independently verifies digests and path confinement.

Consequences:

- An external app is addressed by its namespaced id everywhere the Apps API and UI touch it; the manifest id survives only inside the snapshot. Installed identity wins over claimed identity in package listings.
- Trust and privacy posture are read from the recorded source, never the package: an external instance is stored `review-required`, and a `privacy-review.json` shipped by an external package is never presented as a MOS review. Installed external apps carry a visible "External · Unverified" badge and an unverified notice.
- Suite Manager and the app agent must be updated together, as with the earlier snapshot-root change: an older agent lacking `apps.package.snapshot.external` fails the install closed rather than falling back to a repository build.
- External updates reuse this identity end to end (see the entry below).

## 2026-07-15: An App Updates From The Source It Was Installed From

Decision: Where an update candidate comes from is decided by the instance's recorded source, not by the caller. `AppPackageService.downloadUpdateCandidate` sends official instances to the reviewed catalog and external instances back to their own registered source, re-resolving the commit and re-running the constrained gate on every call. Both then run the identical update transaction, so external apps add no second update path and no new HTTP surface: the existing `POST /apps/packages/:id/prepare-update` and `/stage-update` routes serve both. The app agent resolves the manifest id it expects from the package id it is given (`x-<namespace>-<id>` resolves to `<id>`, a bare id to itself), which lets a namespaced package stage, build, promote, and roll back while still making it impossible to move a package into an identity that is not its own.

Reason: An external app that could not update would be a trap: owners would install apps that silently rot. Keeping one transaction means the durable operation stages, rollback, health checks, Homepage reconciliation, and identity commits are exercised by both kinds of source rather than a weaker copy being written for the less trusted one. Deciding the source from the instance row rather than a parameter means a caller cannot ask for an external app to be updated from the official catalog, or the reverse.

Consequences:

- MOS cannot report an external app's update availability from cached catalog metadata, because only that repository knows what it publishes. External instances report `catalogUpdate.status: 'external-source'` and the owner checks on demand; official instances keep their cached badge.
- An update is refused, with the installed version left running, when the source is unregistered, not active (unavailable/key-rotated/compromised/removed), or has started publishing a different package id.
- A permission increase from a non-MOS-reviewed candidate is `operator-action-required`, so it forces explicit owner consent; the same increase from the reviewed catalog is reported but not gated, because the review covered it. Route hosts are re-checked at update for non-reviewed candidates, as at install.
- A candidate that reuses the installed version number is never applied as a silent update. It was originally reported as `updateStatus: 'integrity-error'`; see the 2026-07-24 entry for why that was reduced to `current`.
- Setup values a candidate newly requires are collected in the update dialog and committed with the update. Only keys the instance does not already hold are created, so an update cannot rotate a generated secret or overwrite an owner's value, and values collected for an update that never commits are removed rather than left on disk.
- Updating an external app requires app-agent contract version 7, the same as installing one.
- An external update follows the repository's default branch. A source record stores the normalized repository URL and its last resolved commit, not the ref it was installed from, so an owner who installed from a `/tree/<tag>` link is offered the default branch's package when they check for updates. This is safe (same repository, same gate, same consent and permission diff each time) but not obvious; persisting the ref needs an `app_sources` column and is left as follow-up.

## 2026-07-17: An App's Web Address Is Its Route Host, And External Hosts Are Reserved

Decision: An app's public host is derived from its projected primary route host, never from its package id. `applyPackageRuntime` derives `appHost` and `publicUrl` from the caddy projection it is about to apply, rather than accepting them from the caller, and the HTTP layer resolves an installed app's host label through `AppPackageService.publicRouteHostFor`. External packages are placed under a reserved `ext-` route host prefix at projection time — the single point a host enters the runtime — so `notes` from an external repository is served as `ext-notes.<domain>`. `npm run apps:catalog:check` refuses any official package that claims an `ext-` route host or a `x-<8 hex>-` id.

Reason: MOS derived the same value two ways. Suite Manager built `appHost` as `<packageId>.<baseHost>` while the app agent required it to begin with the manifest's route host, rebuilding every Caddy site from that host and discarding `appHost`'s first label. The two agreed only because every official package names its route host after its id. External package ids are namespaced (`x-<hash>-<id>`) for collision safety and therefore can never equal their route host, so every external package with a route installed successfully and then failed to apply with `INVALID_APP_RUNTIME_REQUEST: appHost is invalid`. Route host was already the real identity elsewhere — `assertRouteHostsAvailable` reserves it installation-wide and `linkEntryForHomepage` already built its URL from it — so the id-based derivation was the outlier, not the contract.

The reserved prefix answers a question a denylist cannot: MOS cannot enumerate the names of its own future apps, so it cannot protect them by listing them. Confining external hosts to a prefix MOS promises never to ship inverts that, and covers `home` and every name MOS has not thought of yet.

Consequences:

- No migration. External apply had never succeeded, so no external app was serving any address under the previous scheme. Official apps are unaffected: their id and route host are identical, which `test/unit/app-runtime-host-contract.test.cjs` now asserts so that a future official package cannot silently move its own public address by breaking the convention.
- The prefix does not make external apps unique to each other. Two packages claiming `notes` still contend for `ext-notes`, and the second install fails `APP_ROUTE_HOST_TAKEN`, which is what a route host being global to the installation means. It does make it impossible for an external package to take, shadow, or collide with an official app's address — the case the collision check previously had to refuse.
- The collision check compares effective hosts. Comparing a manifest's raw host against a stored projection would compare `notes` to `ext-notes` and find no clash.
- An external route host is limited to 59 characters, because it is served with a 4-character prefix inside a 63-character DNS label. It is rejected at the candidate gate rather than at apply.
- The permission surface shown for consent names the address that will really be served (`route:ext-notes`). Both sides of an update comparison are described with the same namespace, so a namespace difference can never be read as an app widening its access.
- The two sides of this contract are tested together. Suite Manager's tests inject a stub agent and the agent's tests hand-write their own requests, so nothing ran a real Suite Manager request through the real agent validation and the two were free to drift. `test/unit/app-runtime-host-contract.test.cjs` closes that boundary and keeps the id-based derivation as an explicit regression.

## 2026-07-19: Recovery Separates Portable State From Reinstallable Software And Optional Local Snapshots

Decision: MOS recovery uses an appliance-style layered model. Portable backups contain the complete inventory and opaque contents of authoritative MOS-owned persistent state, plus identities needed to recreate compatible software. Containers, networks, images, routes, Homepage entries, and generated runtime configuration are disposable projections rebuilt from that state. A successful full restore reconciles both presence and absence: persistent resources not in the backup cannot remain active or be silently reused. VM, filesystem, and provider snapshots may later provide fast local rollback, but remain supplementary and are not portable replacement-machine backups.

Reason: A Hyper-V drill restored Suite Manager and Homepage to a Stirling-only checkpoint but left post-checkpoint Seafile volumes on disk. Reinstalling Seafile generated new database credentials and reused the old MySQL state, proving that metadata rollback without exact resource reconciliation is unsafe. The backup engine must stay independent of daily feature and app changes, while a hibernation/disk image alone is too substrate-specific for replacement-machine recovery. Home Assistant demonstrates the intended separation: reinstall the managed software/apps and restore stable configuration and app data.

Consequences:

- Every MOS-created persistent resource needs authoritative ownership and stable logical identity; resource name prefixes alone are not sufficient authority for destructive restore.
- New apps participate by declaring MOS-owned persistent resources and reproducible package identity, not by adding app-specific backup code.
- Backup manifests describe the complete authoritative persistent-state target. Absence is part of full-restore semantics; ephemeral runtime is reconstructed and semantically verified rather than preserved by identity.
- Restore validates before mutation, preserves one recoverable previous state, records interruption durably, restores into an inactive target where practical, and verifies before activation. Automatic rollback is later hardening.
- Generation-based persistent storage is the preferred simplification to investigate, not an adopted implementation. It must first prove safe mounts, bounded disk use, migration, and deterministic interruption behavior.
- Portable restore remains the primary disk-loss and replacement-machine path. Local snapshots are a separate optional capability with clearly stated consistency and portability limits.
- Until these guarantees pass destructive and replacement-machine drills, MOS must describe full restore as experimental rather than an exact machine rollback.

## 2026-07-19: Restore Uses A Journaled Rescue Generation, Not A Generation-Switched Store

Decision: MOS restore does not adopt the `/var/lib/mos/generations` switched-store layout. The investigated criteria ruled it out for the data that matters: Docker named volumes are created and mounted by name inside `/var/lib/docker/volumes`, so a generation switch of MOS-managed paths cannot cover app data without either migrating every app to bind mounts (a breaking change to existing installations and to Dockerfile/Compose deploy compatibility) or manipulating Docker's internal storage, which the reliability plan forbids. A generation tree limited to the control-plane directories would switch only a small fraction of persistent state and could not make activation of the whole recovery point atomic, which was the layout's only advantage. Instead, restore preserves safety with the smallest mechanism that meets the plan's fallback requirement: a durable restore journal, exactly one complete rescue generation (control-plane state plus every MOS-owned volume, archived and readability-checked before any deletion), absence-reconciled volume replacement, and post-restore verification that gates the success report.

Reason: The generation layout's proof obligations failed at the first two gates (Docker mounts without touching Docker internals; migration safety for existing installations), and its remaining benefits — bounded disk use, deterministic interruption behavior, one recoverable previous state — are achievable with archives and a journal at a fraction of the migration risk. A restore that fails or is interrupted now leaves a machine that says so: the journal survives until verification passes, new backup/restore work is refused until the owner explicitly acknowledges the incomplete restore, and the rescue generation is retired only after its replacement is complete and proven readable.

Consequences:

- `infrastructure/persistent-state.cjs` is the single contract for state classification, volume naming, ownership labels (`mos.owned`, `mos.package`, `mos.instance`, `mos.resource`), backup schema versions, and the beta size ceiling. The apps agent creates volumes explicitly with these labels before `docker run` can create them unlabeled, and refuses a volume still bound to a different installation instead of silently adopting its data.
- The backup engine (`system-agents/backup/agent-core.cjs`) runs behind injected system adapters, so the rescue, reconciliation, journal, and verification guarantees are enforced by unit regressions — including the Stirling-then-Seafile false-restore drill — rather than only by Hyper-V runs.
- Restore selects volumes by ownership evidence (label first, per-package name derivation second); a volume wearing the `mos-app-` prefix that matches no known package is reported and left untouched, never destructively claimed.
- Bundles are schema version 3 (owned-resource inventory, ownership evidence, raw-size accounting, consistent `VACUUM INTO` database snapshot); restore accepts versions 2-3 and re-derives ownership for version 2 from the bundle's own package inventory.
- The first safe failure mode requires explicit operator action by design: interrupted or failed restores block new jobs until acknowledged, and manual rollback from the rescue generation is the documented recovery path until automatic rollback is proven.

## 2026-07-24: App Update Availability Is Decided By Version, And Package Digests Are Verified Where They Are Downloaded

Decision: `OfficialCatalogService.updateFor` and `compareAppPackages` classify an update from the package version alone — newer is `update-available`, older is `installed-newer`, equal is `current`. The `integrity-error` status is removed, along with the Apps-screen pill and notice that surfaced it. Candidate contents are still verified against the signed catalog digest, at the point MOS downloads them to apply (`downloadCandidate`, `CANDIDATE_DIGEST_MISMATCH`), which is unchanged.

Reason: the removed check compared two digests that were never contracted to match. An official app is installed from the git checkout on the box, not downloaded from the catalog — `installPackage` hashes the local package directory, and records the digest as the source revision precisely because that path has no resolved commit of its own. So the installed digest describes whatever contents that checkout held, while the catalog digest describes the tip of the catalog branch. They are equal only when the checkout sits exactly on that tip: false for every box pinned to a release tag, and false for every box tracking `staging`. Treating their inequality as tampering reported the ordinary case as a fault, in a warning box, on a freshly installed app. It was also self-inflicted at scale — adding a privacy review to all six catalog apps under unchanged version numbers put every installed box one merge to `main` away from seeing it on every app, with `unsupported` blocking the update that would have resolved it.

The digest remains the right check in the one place there is something real to compare against: bytes MOS just downloaded, against the digest a signed catalog declared for them.

Consequences:

- Same-version-different-contents is `current`. It is not offered as an update and cannot be applied, which is the outcome `integrity-error` already produced — without describing the normal case as a fault.
- Publishing a package change now requires a version bump to be reachable at all, since availability is decided by version. `npm run apps:version:check` (`scripts/app-version-guard.cjs`) enforces this in CI by comparing the generated catalog against the one published on `main`, and also refuses a version that moves backwards. `npm run apps:catalog:check` cannot catch this class on its own: it only proves catalog.json matches the working tree.
- Bumping a package version means re-stamping its `privacy-review.json` `scope.packageVersion`, because that field is part of the hashed package contents. `scope.packageDigest` is placeholdered before hashing, so writing the new digest back does not move it.
- The app catalog branch remains `main` (`MOS_APP_CATALOG_BRANCH`) regardless of the platform update track. A box tracking `staging` therefore compares its packages against `main`'s catalog and reports `installed-newer` while staging is ahead, which is quiet and correct. Making the catalog branch follow the update track is a separate, still-open question.

## 2026-07-24: A Privacy Review Binds To Package Contents, Not To The Commit That Contains It

Decision: `validatePrivacyBinding` no longer requires `privacy-review.json`'s declared `scope.source.revision` to equal the resolved source revision. `kind`, `repository`, `path`, and `trust` are still compared exactly, and the declared revision is still shape-checked by `validateSourceIdentity`; it is provenance, not identity. `packageDigest` remains the binding that ties a review to the exact package it describes.

Reason: the comparison was unsatisfiable by construction. A review is a file inside the commit a resolved revision names, so the commit it declares can never be the commit that contains it. That made the check mean two different things in the two places it ran. On install there is no resolved commit, so `installPackage` adopts the review's own declared revision and the check compared a value to itself. On update there is a real one — the commit the catalog refresh resolved the catalog branch to — so the check could never pass, and every official candidate shipping a review was refused with `APP_PRIVACY_REVIEW_INVALID` before it could be staged. Neither outcome discriminated between a good package and a bad one. The gap survived because all seven successful-update tests deleted the candidate's `privacy-review.json` first, and the one test that keeps a review only exercises install, where the check is vacuous.

Consequences:

- Official apps that ship a privacy review can be updated through the catalog. This path had never run: the reviewed posture was not degraded on update, the update was refused outright.
- No protection is given up. Content substitution is caught by `packageDigest`, which on the update path is verified twice — once against the signed catalog entry when the candidate is downloaded (`CANDIDATE_DIGEST_MISMATCH`), and again in the binding itself. A review still cannot describe a package other than the one it ships with.
- `suite-manager/backend/test/app-package-service.test.cjs` covers a reviewed official candidate updating and keeping its posture, with a candidate source revision that differs from the review's declared one — the only shape the catalog can produce.
- Authoring a review no longer needs to guess a future commit. Record the commit the assessment was made against and leave it; it is read as provenance.

## 2026-07-30: The Backup And Restore Guarantee Is Verified, With Three Recorded Deviations

Decision: the recovery contract proven by the July 2026 drills is the durable one, and the three
architectural deviations from the original plan are accepted rather than open work. Recorded here
because `docs/backup-restore-reliability-plan.md` was retired into `docs/roadmap.md` and
`docs/decisions.md` on 2026-07-30, and the evidence behind a `verified` guarantee must outlive the
document that gathered it.

The contract:

> After a successful full restore, MOS authoritative persistent state and installed-package state
> match the validated backup. No MOS-owned persistent resource created after that backup remains
> active or can be silently reused. Runtime projections are freshly reconstructed and verified.

Invariants that must not regress:

1. MOS enumerates all persistent state it owns without an app allowlist.
2. Full restore reconciles presence **and absence**. The July 19, 2026 drill that started this work
   was a false restore: the control plane rolled back to a Stirling-only backup while Seafile's
   post-backup volumes survived, so reinstalling Seafile generated new credentials against old MySQL
   data and authentication failed.
3. Non-MOS resources are never selected by guesswork or broad name prefixes; ambiguity is reported
   (`ambiguousVolumes`), never claimed.
4. Bundles are portable to a clean compatible MOS installation.
5. Stateful workloads are stopped or quiesced at the consistency boundary.
6. Bundle integrity, compatibility, paths, and required space are validated **before any mutation**.
7. An interrupted restore can never be reported as successful.
8. A recoverable previous state is preserved until the new state is verified.
9. A newly packaged app only declares persistent resources and a reproducible package identity — it
   never implements backup orchestration.

Accepted deviations from the original plan, all deliberate:

- **Restore is validated-then-in-place after a complete rescue copy**, not a swap onto an inactive
  target. Generation-switched storage was rejected on 2026-07-19 (see the decision below): Docker
  named volumes cannot be re-pointed without bind-mount migration or touching Docker internals, and a
  control-plane-only generation tree cannot make whole-state activation atomic.
- **Restore reuses the installed MOS software** with the bundle's validated package snapshots rather
  than recreating the recorded MOS version. A recorded-vs-current version mismatch is surfaced as a
  validation warning on both the read-only check and the restore job.
- **Activation is in-place**, so verification gates the success *report* rather than the activation.
  The safe-failure half holds: failure leaves a journal, a rescue generation, and a blocked agent
  requiring typed acknowledgment. Automatic rollback is roadmap item **D3**.

Drill evidence behind the `verified` guarantee (owner-run, Hyper-V, July 20-21 2026):

- Three restore points (Stirling-only; Stirling + Seafile + Immich with data; + Radicale) restored in
  both directions with apps, users, files, and credentials intact, and absence reconciled each time.
- Replacement-machine recovery onto a fresh VM using only the downloaded bundle plus the owner
  password, uploaded through the Backups screen: 3 apps / 11 volumes verified matched.
- Database-backed multi-service (Seafile/MySQL, Immich/Postgres) and a ~6 GiB Seafile workload.
- Refusals all correct: stream-level and checksum-level corruption, out-of-window schema version,
  insufficient destination space, disconnected destination.
- Power-loss interruption at major boundaries, including a sysrq hard reset during app reconciliation
  mid-restore: the journal survived, new jobs were blocked, the dead worker's job reconciled to
  failed, typed ACKNOWLEDGE unblocked, and re-restoring the same bundle converged to a verified state.

Two bugs the drills found are the reason these invariants are written down:

- **A backup to a detached drive succeeded.** The mountpoint directory outlives the mount, so 13 GiB
  landed on the system disk and the job reported success while the bundle was invisible in the list.
  Fixed at both ends — jobs refuse a destination that is not a live mount at start
  (`assertMountedDestination`), and the engine refuses to write the COMPLETE marker if the destination
  is no longer mounted at completion. **New destination types must preserve both checks.**
- **A job whose detached worker died pre-journal reported running forever** and blocked new jobs.
  Fixed by reconciling the current job against the live worker process (`reconcileCurrentJob`).

## 2026-07-30: Beta Cutover Audit Invariants

Decision: the regression checks established by the July 2026 beta-cutover audit are durable
contracts, not release-specific checklist rows. Recorded here because
`docs/beta-main-cutover-checklist.md` was retired on 2026-07-30 once every blocker and high-priority
item in it had shipped (v0.13.0 through v0.15.0).

Must not regress:

- **Platform updates never claim to have updated installed apps.** Installed apps run from validated
  package snapshots and are deliberately outside a platform update's scope; app rebuilds from changed
  package files flow only through the per-app update transaction, never a silent core-update rebuild.
- **No UI or documentation surface presents an update track as installable before it is.** The
  service-level refusal stays ahead of the agent's own rejection.
- **Owner credentials and session cookies are never sent over public HTTP.** A new cloud install
  cannot be claimed by an unauthorised visitor; the smoke harness may read the claim token over SSH
  only to print the one-time URL, and must never persist it in smoke state or log files.
- **The stable and development installer Workers stay separate**, both configured in the repository,
  and the DigitalOcean and Hyper-V harnesses consume the public development endpoint rather than
  maintaining an alternate installation path.
- **Installer input and generated seed never contain Suite Manager owner credentials.** Only the
  machine login and legitimate host settings are installer inputs.
- **Bundles gain no payload type that escapes per-archive hashing**; restore preflight keeps running
  every integrity and compatibility check before the first destructive step; restore success stays
  gated on inventory verification and is never inferred from job completion.
- **The site keeps building from a clean install in required CI**, and deployment happens only from
  `main` and `staging` through the deploy workflow.
- **Platform behaviour, upstream-package assessments, external-package claims, and public-site
  analytics are described separately.** A new or updated app stays unrated until an assessment bound
  to its exact package identity passes the repository checks.
- **Every supported installation path names a destination the server can actually mount**, and new
  destination types are not advertised before backup *and* restore support exists.
- **Login throttling stays bounded** — it must not enable trivial permanent denial of service — and
  security events stay secret-free, with forwarded addresses trusted only from the loopback Caddy
  boundary.
- **Any new create, export, or download surface warns before a bundle leaves MOS-managed storage** and
  never implies an unencrypted browser or cloud copy is safe.
- **Active documentation describes current paths.** Historical names appear only in archive,
  migration, rollback, or compatibility context, and no numbered MOS generation label is reintroduced;
  upstream API and dependency version strings are not generation labels and must not be rewritten.
- **Follow-up fixes in the same release area update an existing changelog outcome bullet** unless they
  add a distinct user-visible, operational, security, or compatibility result.

Properties verified as already strong, which the audit flagged as regression-sensitive: app packages
stay manifest-driven with digest-pinned base images and root-level Dockerfile paths; Stop stays
non-destructive and Uninstall stays explicitly destructive with a confirmation that spells out what is
deleted; Suite Manager stays unprivileged and delegates bounded host work to narrow Unix-socket
agents; Cloudflare tokens stay in root-only storage and are never returned by the API or logged; owner
passwords stay scrypt-hashed and only session-token hashes persist; Homepage stays loopback-only
behind the Suite Manager session boundary; app secrets stay redacted from public projections; and
MOS-owned Homepage links are reconciled without rewriting arbitrary user-authored links.

**Claim discipline.** Approved framing, at the confidence level the product can support:

> My Own Suite is an open-source, self-hosted app launcher for running private apps on hardware you
> control. MOS is currently beta: installation and recovery still require some technical comfort, but
> everyday app management happens in one browser interface.

Avoid until the corresponding capability exists: "one-click updates" without precise
runtime-reconciliation scope; "everything included" backups without recovery prerequisites; "only you
hold the keys" for rented cloud servers; any claim that MOS universally removes upstream app
analytics; and "safe to use" without the intended beta risk profile.
