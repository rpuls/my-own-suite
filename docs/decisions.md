# Decisions

This file records architectural decisions that should survive beyond a single issue or PR. Keep entries short, dated, and practical.

For documentation ownership rules, see [docs/README.md](./README.md).

## 2026-07-11: Post-Cutover Repo Hygiene And Public Site Continuity

Decision: `AGENTS.md` is the single tool-agnostic agent instruction file; `CLAUDE.md` exists only as a loader pointer for Claude Code, and tool-specific rule folders (`.codex/`, `.agents/`, `.clinerules/`) are removed. The deployed public site keeps building from the preserved MOS1 source: `site-mos1-reference/` embeds frozen MOS1 technical reference copies under `src/reference/` (taken from `archive/mos1-main-snapshot`) instead of reading live `apps/` packages, root `npm run build` builds it, and Cloudflare Pages output is `site-mos1-reference/dist`. Release metadata guardrails (`npm run release:check`) cover root `VERSION` and `releases/stable.json` only until MOS2 gains stable release-track managed updates.

Reason: The cutover left agent rules split across tool-specific folders, silently broke the public site build by making MOS1 docs import MOS2 package READMEs (or removed paths), and dropped the `hooks:install`/`release:check` guardrails that root docs still referenced. The public site documents the latest published release, which is still MOS1, so it must stay buildable and deployable without depending on removed MOS1 runtime paths.

Consequences:

- New hard agent rules go to `AGENTS.md`; durable working context goes to `docs/codex-notes.md`; no new tool-specific rule folders.
- The MOS1 site is content-frozen: factual fixes only, no new product docs; the MOS2 public site rebuild happens under `site/`.
- CI runs the MOS2 workspace checks, the release metadata check, and the preserved public site build; paid/destructive smoke and full E2E remain human-run.
- A Suite Manager release metadata file returns, with `release:check` coverage, when MOS2 stable-track managed updates land.

## 2026-07-10: MOS2 Replaces MOS1 As The Default Repository Layout

Decision: MOS2 is the default root layout. The former `version-2/` workspace has moved to root-level `suite-manager/`, `apps/`, `system-agents/`, `infrastructure/`, `scripts/`, `shared/`, and `test/` paths. The old MOS1 root shape is preserved on `archive/mos1-main-snapshot`; the old public site source remains in `site-mos1-reference/` only as reference while the MOS2 public site/docs are rebuilt later.

Reason: MOS2 is now validated enough to replace the isolated lab shape, and there are no external MOS1 users whose migration blocks the repo default. Keeping MOS2 under `version-2/` would make installers, managed updates, docs, package paths, and contributor behavior keep carrying a temporary architecture.

Consequences:

- New development should target the root MOS2 layout and `staging` integration branch.
- Installed bootstrap/update/reconciliation paths use `/opt/mos-v2/repo/...`, not `/opt/mos-v2/repo/version-2/...`.
- App runtime build contexts use `apps/<app-id>`.
- Root npm commands such as `npm test`, `npm run build:client`, and `npm run install:render` replace `npm --prefix version-2 ...`.
- MOS1 runtime code is not kept in the active root layout; use the archive branch for recovery or reference.
- Public landing page and end-user docs cleanup is deliberately deferred from the functional cutover.

## 2026-07-08: V2 Homepage URL Reconciliation Is Metadata-Scoped

Decision: V2 Homepage URL reconciliation is driven by MOS metadata, not by blind URL search/replace. Plain user-authored links remain untouched. MOS catalog app tiles are updated only when their stable Homepage entry ID matches an installed app instance. Non-catalog LAN/home-service tiles are updated only when they carry structured `mos.proxy` metadata, which regenerates the public URL and Caddy route from the current domain state.

Reason: Homepage can intentionally contain unrelated internet shortcuts, MOS-owned app package shortcuts, and user-managed LAN apps exposed through MOS HTTPS. DNS/domain changes should repair the two MOS-managed classes without corrupting arbitrary links that happen to use old domains or HTTP.

Consequences:

- App package routes and Homepage customization routes remain separate generated outputs.
- HTTPS/DNS-01 apply may trigger app runtime route reapply and Homepage projection reconciliation, but it must not rewrite unannotated links. Homepage/home-service reconciliation runs as its own phase, and per-app runtime failures are reported as partial reconciliation instead of silently turning HTTPS apply into a misleading success.
- Catalog app widget URLs follow the app's current public URL when the tile is MOS-owned by app instance ID.
- Home-service proxy routes follow `mos.proxy` metadata and current domain state; the source Homepage template remains the user-facing ownership document.

## 2026-07-04: V2 App Integrations Use Capability Relationships

Decision: V2 models optional app-to-app integrations as capability relationships between independently installable packages. A provider package exports a capability, a consumer package imports a compatible capability, and Suite Manager records an explicit relationship with its own lifecycle, projections, and redacted secret grants. ONLYOFFICE is an independent document-editor provider; Seafile is one compatible document-platform consumer, not the parent package.

Reason: Seafile plus ONLYOFFICE is the first concrete case, but the architecture should also fit future file platforms, SSO providers, SMTP providers, object storage, backup targets, databases, caches, and media helpers. Bundling ONLYOFFICE into Seafile would make Seafile heavier and would hardcode one app pair into the product model.

Consequences:

- Suite Manager may render generic compatibility and "connect" actions, but production core must not hardcode Seafile/ONLYOFFICE-specific environment names or app pair logic.
- Integration state must be separate from each app's install state so one provider can serve multiple consumers and one consumer can degrade cleanly if a provider is disabled.
- Shared integration secrets are grants, not arbitrary cross-app secret reads. They must stay out of public APIs, logs, projections, and broad SQLite rows.
- Provider or consumer route/secret changes must make affected relationships require reapply or revalidation.
- Provider/consumer lifecycle actions must update relationship state truthfully and reapply or revalidate compatible active relationships where safe.
- Capability-provider and companion packages may omit Homepage contributions; Suite Manager should present them as integration services rather than ordinary app destinations.
- Complex pair-specific glue may be introduced later only through a reviewed package-owned contract, not arbitrary frontend code or broad shell hooks.

## 2026-07-05: V2 Managed Updates Use A Narrow Host Agent And Reconciliation Script

Decision: V2 managed updates are requested from Suite Manager but applied by a root-owned `mos-v2-update-agent` over a local Unix socket. The first supported apply path is branch-track updates for V2 lab and Hyper-V validation. The update worker fetches and fast-forwards the configured branch, installs V2 dependencies, rebuilds Suite Manager frontend assets, and runs `version-2/scripts/reconcile-system.cjs` to refresh repo-owned systemd units, host agents, Caddy override/binary wiring, socket directories, and control-plane service restarts.

Reason: This preserves the successful V1 model where the web app communicates intent while a host-owned updater applies infrastructure changes. V2 has more separated agents than V1, so the refresh path must reconcile all repo-owned host services instead of only recreating a Compose stack.

Consequences:

- Suite Manager must not run git, npm, Docker, Caddy, or systemctl update commands itself.
- The update agent API stays narrow: status, start update job, read job state, and configure track.
- The update result may report core reconciliation success while installed app runtimes are preserved and marked for manual reapply/restart after package Dockerfile or manifest changes.
- A later updater slice should add package-aware runtime reconciliation so changed installed app packages can be rebuilt/reapplied automatically without weakening app data that still belongs to installed or stopped apps.
- Stable release-track polish can reuse the same agent boundary, but branch-track updates remain the practical validation path until V2 release metadata is finalized.

## 2026-07-03: V2 App Packages Own Runtime Shape And Lifecycle

Decision: V2 app packages are self-contained folders under `version-2/apps/<app-id>/` that declare metadata, setup fields, services, routes, Homepage projections, health checks, widgets, onboarding, and capabilities. Suite Manager persists app instance/config/projection/operation state in SQLite and asks a narrow app agent to apply Docker, Caddy, and health changes. Runtime state supports health refresh, disable, re-enable, restart, and destructive uninstall.

Reason: V1 scattered app-specific behavior across Compose files, env generation, Caddy generation, onboarding, doctor scripts, and Suite Manager UI. V2 needs adding an app to mostly mean adding a package folder, while keeping privileged host actions out of the web process.

Consequences:

- App-specific code and Dockerfiles belong in the package folder; Suite Manager core and host agents operate on validated generic projections.
- Generated infrastructure must be reproducible from package manifests plus persisted app/relationship state.
- Secrets use redacted references in normal state and are materialized only for narrow runtime apply operations.
- App routes remain separate from Homepage customization routes.
- Stop/disable is the non-destructive pause action: it removes runtime containers but keeps app routes, Homepage shortcuts, volumes, config, and secrets so the app can be started again.
- Uninstall is the destructive removal action: it removes runtime containers, package routes, MOS-owned Homepage shortcuts, package Docker volumes, Suite Manager app instance/config/projection state, app secrets, and app integration rows so the catalog returns to a fresh installable state.
- If MOS later needs an archive-data workflow, it should be a separately named action instead of overloading uninstall.

## 2026-07-02: V2 App Setup Guides Are Declarative And App-Scoped

Decision: V2 app packages may declare post-install setup guides in their manifest `onboarding` metadata. Suite Manager renders those guides generically from declarative sections such as copyable non-secret values, notes/warnings, device/client choice guides, ordered steps, and manual completion actions. Guide state is stored per app instance in SQLite as viewed, completed, or skipped, and completed/skipped guides stay quiet while remaining available from the app detail view.

Reason: Some apps are technically running after install but still need human setup in an external client or device. Radicale is the proving case: Suite Manager can show CalDAV/CardDAV server details and device instructions without hardcoding a Radicale React page or trying to automate each client. This keeps app-specific help attached to the installed app instead of polluting global owner onboarding.

Consequences:

- Package guide metadata must remain declarative; package manifests must not include arbitrary JavaScript, shell commands, database queries, or app-specific React components.
- Guide values may interpolate app public URLs and non-secret config values. They must not reveal or copy raw secrets; secret fields should be explained as user-entered or app-native values.
- Suite Manager persists guide state per app instance, not in the old global onboarding state.
- App-native onboarding remains app-owned when it is good enough. Suite Manager should guide the owner only where MOS can add clear contextual value.
- Richer guide capabilities such as per-section progress, secret reveal, app-specific observers, or custom components require a separate reviewed contract.

## 2026-06-20: V2 HTTPS Is Applied By A Narrow Host Agent

Decision: V2 configures post-install HTTPS from authenticated Suite Manager Settings, but a dedicated root system agent owns Cloudflare token storage and Caddy mutation. V2 builds a pinned Caddy binary with `caddy-dns/cloudflare`, stores only non-secret HTTPS state in SQLite, retains the installer-created HTTP Home host for recovery, and uses `home.<base-domain>` as the configured HTTPS origin.

Reason: Stock Caddy packages do not contain the external Cloudflare DNS provider, while the web process must not gain general host privileges or persist DNS credentials in ordinary application state. Keeping the existing origin live during a transactional apply also lets Suite Manager report the new URL without restarting itself mid-request.

Consequences:

- Bootstrap and managed updates must reproducibly rebuild, verify, install, and select the MOS-owned Caddy binary.
- The HTTPS agent exposes only structured status/apply/commit/rollback operations over a restricted Unix socket; it is not a general host shell or DNS manager.
- Cloudflare credentials live only in a root-owned secret environment file and must never appear in SQLite, generated Caddy text, public APIs, logs, or diagnostics.
- Candidate Caddy configuration is validated, atomically installed, reloaded, and rolled back on failure before Suite Manager records it as active.
- The configured HTTP Home host redirects to HTTPS, while the original authenticated HTTP bootstrap host remains available for transition and recovery.
- Host-only sessions are not transferred between origins; users sign in again and HTTPS responses set `Secure` cookies.

## 2026-06-19: V2 Homepage Is Authenticated Through Suite Manager

Decision: V2 exposes one `home.<domain>` control-plane origin through Caddy. Suite Manager owns `/suite-manager/`, authenticates the shared origin, and proxies all other authenticated paths to the private loopback Homepage service. Sessions remain host-only; V2 does not share a parent-domain session cookie across app subdomains.

Reason: Suite Manager already owns owner identity and sessions. Keeping Homepage behind it avoids duplicating session validation in Caddy and prevents a direct public bypass, while host-only cookies keep MOS credentials away from future independently authenticated apps.

Consequences:

- Home serves Suite Manager onboarding/login/account controls at `/suite-manager/` and the authenticated Homepage dashboard at `/`.
- Caddy has no direct Homepage upstream; Homepage binds only to loopback.
- Dashboard and Suite Manager share one browser session without exposing that credential to future app subdomains.
- Suite Manager must preserve streaming, redirects, forwarded headers, and WebSocket upgrades while removing its session cookie before proxying Homepage.
- Homepage runtime files are seeded into durable state; `services.template.yaml` is the future editor-owned source and `services.yaml` is its generated stock-Homepage projection.

## 2026-06-18: V2 Restarts From A Suite Manager-First Lab

Decision: The V2 app platform work restarts from a clean branch based on `staging`, with new implementation isolated under a root-level `version-2/` workspace. The first milestone is not app catalog expansion; it is a reliable control-plane install and Suite Manager browser-based owner creation flow. The existing repo code and the previous app catalog prototype branch remain reference material for lessons and selective future extraction, not code to run through or merge wholesale.

Reason: The prototype proved important concepts, but it also mixed old preloaded-suite assumptions with new launch-platform behavior across many files. Starting with a narrow Suite Manager-first lab lets MOS design the new platform around first-run ownership, testability, and clean package boundaries before optional app lifecycle code biases the foundation.

Consequences:

- Installer and DigitalOcean validation work should prove that owner credentials can move from installer input to browser setup.
- Optional app package work waits until the Suite Manager install and first-run owner flow are trustworthy.
- Existing Suite Manager UI primitives should be reused for the owner setup experience.
- `version-2/` is the home for new platform code until V2 is proven; existing `apps/`, `scripts/`, `deploy/`, and `agents/` code should be treated as old-system reference material unless explicitly copied or rebuilt into V2.
- The V2 workspace may keep temporary planning docs while active, but durable architecture belongs here and task state should move to GitHub Issues before merge.

## 2026-06-11: Alpha Moves Toward Control-Plane-First App Catalog Installs

Decision: Fresh MOS own-infra installs should move toward installing only the control plane by default: Suite Manager, Homepage, Caddy, and required host agents. The owner should create the MOS account in Suite Manager on first browser visit, then choose apps from a Suite Manager-managed catalog. App installation should update the repo-owned Compose generation, Homepage YAML, Caddy generated config, env files, and app-specific setup helpers as needed.

Reason: The current preloaded-suite model forces installer-time owner credentials because some apps need user seeding during bootstrap. That makes USB and cloud installers harder to align and makes fresh installs feel more opinionated than necessary. A catalog model lets MOS install the machine runtime first, then let the owner decide which apps to add and what credentials each app should use.

Consequences:

- Installer front doors should stop requiring owner email/password once Suite Manager first-run owner creation and app catalog provisioning are ready.
- Suite Manager becomes the friendly control plane for Homepage YAML, generated Caddy config, selected app services, app env files, and app-specific setup flows.
- Existing onboarding logic should be split into suite-level owner setup and app-specific install/setup helpers.
- Fresh installs can become lean by default, while existing installs should be migrated conservatively and never have apps removed automatically.
- The catalog needs a repo-owned manifest/contract for app metadata, Compose participation, routes, Homepage defaults, volumes, provisioning mode, backup behavior, and lifecycle actions.
- The old alpha plan has been superseded by the compact V2 lab plan and durable V2 decisions in this file; task state should move to GitHub Issues before merge or release.

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
- Installed, candidate, and bounded previous package snapshots live under `/var/lib/mos-v2/app-packages` (or `<MOS_V2_STATE_ROOT>/app-packages`). The root app agent owns writes; Suite Manager receives read access through `mos-v2-agent`. The root is provisioned as `root:mos-v2-agent` mode `0750`, while snapshot transaction directories may be stricter.
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
- App-agent contract version 2 adds package-update staging. Staging does not replace the installed snapshot or touch running containers; it establishes the agent-owned, digest-bound candidate required for a later transactional build/apply operation and fails with an identity-changed conflict when either side no longer matches the previewed identities.
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
