# App Platform V2 Roadmap

This is the temporary working roadmap for the clean V2 launch-platform branch. Before this branch merges, convert active work into GitHub Issues and keep only durable decisions in `docs/decisions.md`.

## Session Progress Tracker

Use this section as the first stop when resuming the branch in a new chat session.

### Current Branch State

- [x] Created `feat/app-platform-v2-lab` from `staging`.
- [x] Preserved the previous app-catalog prototype branch as reference material.
- [x] Created root-level `version-2/` as the clean-slate V2 workspace.
- [x] Added a self-contained V2 package with `npm --prefix version-2 test`.
- [x] Added canonical V2 branding under `version-2/branding` with sync outputs for future site, Suite Manager, and Homepage styling.
- [x] Added an executable platform contract that rejects preloaded apps and runtime imports from the old Suite Manager.
- [x] Moved the first implementation under `version-2/suite-manager/backend/` so Suite Manager is one component in the larger V2 workspace.
- [x] Added V2-local file-backed platform state, owner password hashing, session tokens, first-run owner creation API, and minimal first-run HTML.
- [x] Built the first React/Vite V2 Suite Manager owner onboarding app shell.
- [x] Added a V2 no-preconfig bootstrap contract, dry-run renderers for cloud-init, SSH/bootstrap, USB seed config, and a DigitalOcean smoke harness that can create a Droplet and install the V2 control plane.
- [x] Ran the first paid V2 DigitalOcean smoke, diagnosed Caddy repository key placement and Windows SSH-render line endings, repaired the existing Droplet, and verified the public setup API returns `needs-owner`.
- [x] Added and refined the real V2 Caddy/Homepage control-plane slice: one Home origin with Suite Manager at `/suite-manager/`, authenticated private Homepage proxying, the proven V1 Homepage visual layer and bookmark layout, local MOS/Funkyton tile assets, seed-only editable template state, and focused HTTP/WebSocket/render tests.
- [x] Replaced milestone JSON persistence with a Node 22 built-in SQLite store, ordered schema migrations, database-enforced singleton ownership, atomic owner/session creation, hashed sessions, restart-safe auth behavior, and safe one-time JSON import.
- [x] Added responsive Suite Manager navigation, the first authenticated V2 Settings page, migrated non-secret HTTPS state, a narrow rollback-capable HTTPS agent, and a pinned repo-built Caddy binary with the Cloudflare DNS module.
- [x] Added a V2-owned Playwright foundation for real local owner, Homepage, navigation, Settings validation, and logout behavior, plus an explicitly guarded DigitalOcean DNS-01 validation command.
- [x] Fixed the pinned Caddy build for Ubuntu's default legacy Docker builder after a fresh smoke exposed an unset `BUILDPLATFORM` failure before systemd unit creation.
- [x] Added the first V2 Homepage customization slice: authenticated Customize navigation, allowlisted revision-aware YAML editing, guided dashboard links and home services, SQLite apply/revision metadata, generated Homepage/Caddy projections, and a separate transactional rollback-capable Homepage agent.
- [x] Diagnosed the real DigitalOcean Customize apply failure through the live agent/socket/runtime state, fixed the Homepage restart budget and Suite Manager systemd dependency that caused successful writes to roll back, and aligned Customize with V1's file rail, syntax-aware validation/save flow, shared dialog controls, guided link flow, and automatic home-service URL helper.
- [x] Passed the V2-owned local Playwright flow and a fresh human-driven DigitalOcean control-plane validation, including owner setup, private Homepage access, customization, generated home-service routing, logout protection, persistence, and an optimized eight-minute cold install.
- [x] Added and validated the USB-aligned local Hyper-V smoke harness around the shared V2 bootstrap contract, including owner setup, Homepage customization, Cloudflare DNS-01 private LAN HTTPS, generated Caddy home-service routing, and a proxied LAN app reached through a local DNS override.

### Current Next Slice

Build the next real V2 vertical slice inside `version-2/`:

1. Brainstorm the future app-package contract after the validated control-plane slice, keeping installation inputs, secrets, dependencies, volumes, backup, and lifecycle outside Homepage YAML.
2. Convert any remaining temporary V2 roadmap/checklist state into GitHub Issues before merging the branch.
3. Keep public internet exposure outside the facilitated private LAN HTTPS flow; cloud/external-provider installs should continue to point custom-domain HTTPS work to the provider guide.

### Latest Verified Command

```powershell
cmd /c npm --prefix version-2 test
```

Expected result: V2 contract tests pass.

Current result: V2 contract tests, TypeScript checks, the production frontend build, and the V2-owned Playwright flow pass. Fresh DigitalOcean validation confirms external-provider installs show provider-managed custom-domain guidance instead of the private DNS-01 form. Hyper-V USB validation confirms owner setup, private Homepage access, customization, Cloudflare DNS-01 HTTPS for `home.<domain>`, generated Caddy home-service routing, and proxied LAN app access once the local network resolves the generated app hostname to the VM IP.

### Suggested Next Session Prompt

Continue the clean MOS V2 launch-platform branch on `feat/app-platform-v2-lab`. Start from `docs/app-platform-v2-lab-plan.md`. Local Playwright, fresh DigitalOcean control-plane validation, and Hyper-V USB validation pass. Hyper-V confirmed owner setup, Homepage customization, Cloudflare DNS-01 private LAN HTTPS, generated Caddy home-service routing, and LAN app proxying once local DNS resolves the generated app hostname to the VM IP. Next focus is the future app-package contract and converting remaining temporary roadmap state into GitHub Issues before merge.

## Product Goal

Version 2.0 is a self-hosted app launch platform, not a preloaded app suite.

The first user experience should be:

1. Install MOS on a cloud server or own hardware.
2. Open Suite Manager in the browser.
3. Create the MOS owner account.
4. Land in a calm control-plane dashboard.
5. Later choose apps from an app launcher/catalog.

The first milestone stops before step 5. App installation comes only after the control plane, installer, owner setup, and validation loop feel solid.

## Working Rules

- `version-2/` is the only home for new V2 runtime code.
- Existing `apps/`, `scripts/`, `deploy/`, and `agents/` code is old-system reference material until deliberately copied or rebuilt into `version-2/`.
- Do not import the old Suite Manager at runtime from V2.
- Do not copy whole old directories into V2.
- Copy or rebuild one feature at a time, with tests.
- Preserve old facts when they matter, but redesign boundaries around the V2 launch-platform goal.
- Reuse the old Suite Manager design language by rebuilding or copying selected primitives into V2.
- Reuse the DigitalOcean smoke harness only when V2 has a real install path.
- Do not run paid DigitalOcean smoke commands automatically.
- Do not run noisy E2E commands automatically; ask the user to run them and paste relevant failures.

## Architecture Direction

V2 should be organized around these first-class pieces:

- Control plane: Suite Manager, Homepage, Caddy, and system agents.
- Owner setup: first-run account creation in Suite Manager, not installer-time secrets.
- Runtime state: Suite Manager-owned state for owner identity, sessions, platform setup state, and later installed apps.
- Branding: one canonical V2 source under `version-2/branding`, synced into future site, Suite Manager, and Homepage targets.
- Install substrate: cloud/USB/SSH front doors converge into one own-infra bootstrap.
- App packages: later, each app owns its manifest, setup helper, routes, env needs, Homepage contributions, backup metadata, and lifecycle behavior.
- Projections: later, generated Compose, Caddy, Homepage, env, backup, and update outputs are derived from V2 state and packages.

## Workspace Ownership

```text
version-2/
  suite-manager/      # Control-plane web UI/backend and app lifecycle orchestration.
  site/               # Future public landing/docs site. Do not start yet.
  apps/               # Future package-style apps, one app per folder.
  scripts/            # V2 install, smoke, and developer/operator scripts.
  system-agents/      # Host-side privileged agents.
  infrastructure/     # Shared Caddy, Compose, Docker, and projection substrate.
  branding/           # Canonical shared colors, fonts, marks, favicons, and CSS tokens.
  package.json        # Root V2 workspace commands.
```

Placement rules:

- Suite Manager UI/backend code goes in `version-2/suite-manager/`.
- App-specific manifests, Dockerfiles, setup helpers, Caddy snippets, Homepage contributions, and docs go in `version-2/apps/<app>/`.
- Shared Caddy base config, Compose assembly/templates, Docker conventions, and generated-output contracts go in `version-2/infrastructure/`.
- DigitalOcean, USB/cloud installer, and development scripts go in `version-2/scripts/`.
- Host-level update/backup/service/restore agents go in `version-2/system-agents/`.
- The future landing page goes in `version-2/site/`, but not yet.
- Shared colors and visual tokens change first in `version-2/branding/styles/mos.css`, then sync with `npm --prefix version-2 run branding:sync`.

## Phase Roadmap

### Phase 0: Clean Workspace And Guardrails

Goal: make it obvious where V2 lives and what it is allowed to depend on.

- [x] Create `version-2/`.
- [x] Add V2-local `package.json`.
- [x] Split `version-2/` into product-level ownership folders.
- [x] Add V2 canonical branding source and sync script.
- [x] Add a contract test that rejects preloaded optional apps.
- [x] Add a contract test that rejects runtime imports from the old Suite Manager.
- [x] Add first V2 owner/setup implementation without old Suite Manager runtime imports.
- [x] Add a V2 README section for local development once the polished app shell exists.
- [ ] Add a V2 architecture note inside `version-2/` if the folder needs local technical detail.

Exit criteria:

- `npm --prefix version-2 test` passes.
- A new session can identify the next slice from this roadmap.

### Phase 1: Suite Manager First-Run Owner Setup

Goal: prove the human entry point before touching app installs.

- [x] Choose the V2 frontend app stack inside `version-2/`.
- [x] Create a minimal Suite Manager web app shell.
- [x] Add first-run setup status: `needs-owner`, `signed-out`, `signed-in`.
- [x] Add persistent state storage for owner account metadata.
- [x] Add password hashing.
- [x] Add owner creation endpoint.
- [x] Add duplicate-owner protection.
- [x] Add login/session creation after owner creation.
- [x] Add signed-out login endpoint if not created as part of the owner flow.
- [x] Add session persistence and logout.
- [x] Replace milestone JSON state with migrated SQLite persistence and ordered schema migrations.
- [x] Add minimal first-run owner creation UI.
- [x] Replace minimal first-run UI with polished V2 UI.
- [x] Rebuild/copy only the needed shared UI primitives from the old Suite Manager.
- [x] Add unit/API tests for setup status and owner creation.
- [x] Add V2-owned Playwright coverage for owner setup, navigation, Settings validation, Homepage protection, and logout.

Exit criteria:

- Starting V2 with empty state shows owner setup.
- Creating owner persists state and signs the user in.
- Refreshing after setup does not show owner creation again.
- Duplicate owner creation is rejected.
- Tests pass through `npm --prefix version-2 test`.

### Phase 2: Control-Plane Install Shape

Goal: define and test what "installed MOS V2 control plane" means before optional apps.

- [x] Define control-plane components in V2 state/contract.
- [x] Define required runtime env values for control-plane-only install.
- [x] Define generated state paths.
- [x] Define how Suite Manager discovers its public URL.
- [x] Define Homepage role before app catalog exists.
- [x] Define Caddy role before app catalog exists.
- [x] Define host-agent capabilities needed for first milestone.
- [x] Add tests for control-plane install contract.
- [x] Turn the cloud/SSH bootstrap contract into a real control-plane apply path.
- [x] Replace the Homepage placeholder with a private, Suite Manager-authenticated V2 Homepage dashboard.

Exit criteria:

- V2 can describe a control-plane install without optional apps.
- Owner credentials are not part of installer inputs.
- Required generated files are documented or represented in V2 code.
- Remaining work: USB/own-hardware still needs a real media/bootstrap flow around the shared contract.

### Phase 3: Installer Front Doors

Goal: make cloud, USB, and SSH setup feed the same V2 bootstrap shape.

- [x] Inventory old installer scripts for reusable behavior.
- [x] Decide whether V2 gets new installer scripts under `version-2/` or thin adapters outside it.
- [x] Start V2 cloud installer path as real cloud-init that installs and starts the control plane.
- [x] Make owner email/password absent in V2 install config.
- [x] Keep domain/runtime inputs separate from owner account inputs.
- [x] Add render tests for V2 installer config.
- [x] Add a local dry-run command for installer generation.
- [x] Update docs for the smoke/install foundation.
- [x] Make the cloud-init/SSH payloads perform a real control-plane install.
- [ ] Make USB/autoinstall consume the same contract in a real own-hardware flow.

Exit criteria:

- A cloud-machine install can boot V2 control plane without owner credentials.
- USB and SSH can follow the same bootstrap contract later without custom app logic.
- Current state: cloud and SSH share a tested install contract that starts Suite Manager behind Caddy; USB has the same seed config contract but not a full media flow yet.

### Phase 4: DigitalOcean Validation Loop

Goal: reuse the known smoke harness for real-machine confidence without letting it drive the architecture.

- [x] Decide how the existing smoke harness calls a V2 installer/ref.
- [x] Add V2 mode to the smoke harness or a V2 wrapper.
- [x] Remove owner credential requirement for V2 smoke mode.
- [x] Have smoke output the first-run Suite Manager URL.
- [x] Add a smoke readiness check that does not require app installs.
- [ ] Add optional browser-owner-creation validation once E2E exists.

Exit criteria:

- User can run a fresh DigitalOcean smoke install of V2.
- Smoke validates control-plane readiness.
- Smoke does not install optional apps.
- Smoke does not require installer-time owner credentials.
- Current state: `npm --prefix version-2 run smoke:do:reset` creates or replaces a tagged Droplet, installs the V2 control plane from the selected repo/ref, waits for `/suite-manager/api/setup/status`, and prints the Home and Suite Manager paths. `smoke:do:render` remains the free dry-run.

### Phase 5: Control-Plane Operations

Goal: make the empty platform trustworthy before adding apps.

- [ ] Add update-track display or defer it explicitly.
- [ ] Add host-agent capability display or defer it explicitly.
- [ ] Add backup placeholder/guidance or defer it explicitly.
- [x] Add DNS-01 HTTPS and its explicit base-domain/settings model through a narrow privileged agent.
- [x] Keep the first Homepage dashboard intentionally minimal and branded before optional apps exist.
- [x] Keep HTTPS status and sanitized diagnostics behind Advanced details.
- [x] Add allowlisted Homepage editing, guided dashboard links/home services, and transactional generated Homepage/Caddy apply through a narrow agent.

Exit criteria:

- A user with no apps installed still understands the platform state.
- Missing host capabilities are explained without terminal-first instructions.
- No app-specific UI appears.

### Phase 6: App Package System

Goal: design and validate the package contract after the control plane is real, before building a catalog or adding multiple apps.

Design goals:

- Apps are optional packages selected after owner setup, never preinstalled by the bootstrap path.
- Each package is self-contained under `version-2/apps/<app-id>/`, like a small npm package for one app.
- Common setup, post-install onboarding, projections, status, and lifecycle behavior are declarative enough for generated Suite Manager UI.
- Advanced apps can use controlled hooks and named capabilities without turning the manifest into a brittle programming language.
- Generated infrastructure is reproducible from the package plus persisted app instance state, not hand-edited mystery files.

Non-goals for the first package milestone:

- No public app store or remote catalog browsing.
- No migration from V1 all-app installs.
- No bespoke React setup page per app when a schema-driven wizard can handle the fields and steps.
- No backup/update/restore completeness beyond recording the package metadata needed to design those flows.

Package folder shape:

```text
version-2/apps/<app-id>/
  manifest.json          # or manifest.yaml; one canonical manifest per app
  README.md              # technical app/package notes
  Dockerfile             # primary service image, when MOS builds it
  Dockerfile.<service>   # optional package-owned companion service images
  assets/                # icons, screenshots, seed files, runtime assets
  hooks/                 # optional app-scoped lifecycle helpers
  migrations/            # optional package-state or app-data migrations
  tests/                 # package validation/projection fixtures
  homepage/              # optional package-owned Homepage contribution fixtures
  caddy/                 # optional package-owned route fixtures, not raw user snippets
```

Conceptual manifest fields:

- Metadata: package id, display name, summary, version, category, icon, upstream project, maintainer notes.
- Inputs: typed setup fields, defaults, required flags, validation rules, generated values, secret flags, and redaction labels.
- Onboarding: post-install steps, links, copy/download actions, completion checks, and status messages rendered by Suite Manager.
- Resources: services, volumes, networks, exposed internal ports, env keys, secret references, dependencies, and app-owned Dockerfiles.
- Projections: Compose resources, MOS-owned Caddy routes, Homepage tiles/widgets, env/secret references, health checks, backup hints, and update inclusion.
- Lifecycle: install, apply, disable, uninstall, update, backup/restore, and migration hooks.
- Capabilities: named escape hatches for app-specific behavior that cannot be expressed safely as declarative fields.

Generated setup UI:

- Suite Manager should render ordinary install inputs from manifest field definitions using shared controls such as text inputs, selects, notices, dialogs, and steppers.
- Field definitions should include labels, helper text, defaults, validation, required/optional status, secret status, and whether MOS may generate a value.
- Secret fields should use password-style controls, clear submitted values from client state after apply, and never be returned by status APIs.
- App-specific React setup screens are allowed only for advanced flows that cannot be expressed as schema fields and must be package-scoped.

Generated post-install onboarding UI:

- The manifest should describe normal follow-up steps: open the app, copy a generated value, download an artifact, wait for a health condition, or manually confirm a task.
- Suite Manager should render these steps from the same app instance state and mark them complete through explicit checks or user confirmation.
- Post-install onboarding belongs to installed apps only; it must not pollute global owner setup or the empty control-plane dashboard.

SQLite app instance state:

- Persist package id, package version, instance id, install status, enabled/disabled state, and timestamps.
- Persist normalized non-secret input values and generated non-secret values.
- Persist selected generated resources, projection revisions/checksums, lifecycle operation records, last health result, and last apply error.
- Persist secret references, redacted labels, timestamps, and fingerprints only. Do not persist or return raw secret values from Suite Manager.
- Keep app instance state as the source of truth for installed apps; detected containers or existing files are diagnostics, not ownership.

Secret handling:

- Collect secrets through generated password fields or an approved package-specific flow.
- Send submitted secrets only to the package apply path and the narrow app lifecycle agent that needs them.
- Store raw secrets only in root/agent-owned secret files or a future dedicated secret store with restricted permissions.
- Redact secrets in logs, operation records, diagnostics, API responses, and generated previews.
- Pass secrets into runtime services by reference or controlled env/secret projection, not by writing them into broad editable config files.

Package apply and projections:

- Render Compose resources for installed/enabled apps only.
- Render MOS-owned Caddy route snippets from structured route definitions; do not accept raw Caddy text from users or packages.
- Render Homepage entries/widgets from package metadata and app instance state; Homepage YAML remains presentation/projection, not app install state.
- Render env files or env fragments from declared inputs and secret references without app-specific hard-coding in global init/doctor scripts.
- Apply host changes through a future narrow app lifecycle agent with validation, checkpoint, rollback, and sanitized diagnostics. Suite Manager should own intent and state, not direct host writes.

Lifecycle semantics:

- Install creates app instance state, validates inputs, renders projections, applies resources, starts services, waits for health, and records the applied revision.
- Disable removes runtime exposure and stops app services where appropriate while preserving config, secrets, and volumes.
- Re-enable reapplies projections from package plus persisted state and restarts required services.
- Uninstall defaults to preserving data and secrets unless the user explicitly confirms destructive removal.
- Update validates package migrations, applies new projections, runs app-scoped hooks, records the new package revision, and leaves recoverable diagnostics on failure.

Simple versus advanced apps:

- A boring HTTP app should need no hooks: one service, one route, one Homepage tile, basic env, volumes, and health checks should be declarative.
- Hooks are for real app-specific work: first-admin creation, imports, data migrations, post-start API calls, or upstream quirks.
- Hooks must be app-scoped, capability-declared, validated, logged with redaction, and unable to mutate global platform files directly.

Validation strategy:

- Start with manifest validation tests before any install engine exists.
- Add projection golden tests for Compose, Caddy, Homepage, env/secret references, and health definitions.
- Add SQLite migration/state tests for app instance records and lifecycle operations.
- Add agent contract tests for apply/rollback, status, and secret redaction.
- Add a local lifecycle test for the first app once the engine exists.
- Ask the user to run noisy Playwright only when UI behavior changes.
- Use Hyper-V smoke for local/USB-style lifecycle confidence once the first app exists.
- Ask before paid DigitalOcean smoke and do not run it automatically.

First app milestone:

- Use Stirling PDF as the first intentionally boring real app unless implementation discovers an even smaller real candidate.
- Prove install, generated route, Homepage tile, health, disable, re-enable, and uninstall-with-data-preserved.
- Avoid app store/catalog browsing; the first milestone is the package contract plus one tiny lifecycle.

Unresolved decisions, with recommended defaults:

- Manifest format: use JSON first if validation and tests stay simpler; allow YAML later only if authorship pain justifies it.
- Secret storage backend: start with agent-owned root-readable files and SQLite secret references; revisit a dedicated secret store once multiple apps need rotation.
- Compose output shape: generate a MOS-owned app compose fragment from installed state rather than appending to a static all-app compose file.
- Hook runtime: start with narrow Node or shell helpers executed by the app lifecycle agent with explicit capabilities; do not let hooks run arbitrary global commands.
- Dependency semantics: support package-to-package dependencies only after the first app; begin with control-plane capabilities and package-owned companion services.
- Multiple instances: default to one instance per app id until a real app needs multiple instances.
- Uninstall data removal: preserve by default; destructive delete requires a separate confirmation and should be tested as its own lifecycle path.

Do not repeat V1:

- Do not hard-code app lists, URLs, or generated accounts in Suite Manager config.
- Do not predeclare Compose profiles for every possible app.
- Do not put app credentials or app setup into global owner onboarding.
- Do not use Homepage YAML as the source of app install state.
- Do not accept raw Caddy snippets from app/user input.
- Do not install optional apps at bootstrap time.
- Do not make global init, doctor, update, or smoke scripts know app-specific env details.

Example manifest sketch:

```json
{
  "id": "stirling-pdf",
  "name": "Stirling PDF",
  "version": "0.1.0",
  "summary": "Private PDF tools for everyday document tasks.",
  "category": "tools",
  "setup": {
    "fields": []
  },
  "resources": {
    "services": {
      "stirling-pdf": {
        "dockerfile": "Dockerfile",
        "internalPort": 8080,
        "volumes": ["training-data:/usr/share/tessdata", "configs:/configs"]
      }
    }
  },
  "routes": [
    { "host": "stirling-pdf", "service": "stirling-pdf", "port": 8080 }
  ],
  "homepage": {
    "group": "Tools",
    "name": "Stirling PDF",
    "description": "Work with PDFs without uploading documents elsewhere.",
    "icon": "stirling-pdf"
  },
  "health": {
    "type": "http",
    "url": "http://stirling-pdf:8080/"
  }
}
```

This sketch is illustrative only. Do not treat it as the final schema until manifest validation exists.

Exit criteria:

- App packages can be validated without installing them.
- The package contract does not depend on old preloaded-suite assumptions.
- The first implementation task can build package discovery, validation, state, and projections without inventing new architecture decisions.

### Phase 7: First App Lifecycle

Goal: install one low-risk app end to end after the package contract is validated, without building a full catalog.

- [ ] Pick the first app, likely Stirling PDF.
- [ ] Create the first package manifest and validation fixtures.
- [ ] Add SQLite app instance state and lifecycle operation records.
- [ ] Generate required Compose, Caddy, Homepage, env/secret-reference, and health projections from package plus instance state.
- [ ] Apply changes through a narrow V2 app lifecycle agent or adapter with rollback and redacted diagnostics.
- [ ] Show install, health, disable, re-enable, and uninstall-preserve-data status in Suite Manager.
- [ ] Add idempotency, projection, and lifecycle tests.
- [ ] Ask for user-driven Hyper-V and DigitalOcean validation when local tests are green.

Exit criteria:

- Fresh V2 install can add one app without SSH.
- Re-running install/apply is safe.
- Disable, re-enable, and uninstall-preserve-data are visible and recoverable.
- Failure states are visible, redacted, and recoverable.

### Phase 8: Assisted App Install

Goal: prove that V2 handles richer app setup without polluting global onboarding.

- [ ] Pick Radicale or Vaultwarden as the first assisted app.
- [ ] Move/rebuild only the needed helper UI into the app package.
- [ ] Keep app credentials and device setup inside the app flow.
- [ ] Add package-owned Homepage/Caddy contributions if needed.
- [ ] Add tests proving no global onboarding dependency.

Exit criteria:

- Assisted setup appears only for installed/relevant app.
- Control-plane owner setup remains app-free.

### Phase 9: Backup, Update, And Restore Semantics

Goal: make app lifecycle safe enough for real users.

- [ ] Define backup inclusion from installed app state and package metadata.
- [ ] Define update behavior for installed apps only.
- [ ] Define restore behavior for selected apps.
- [ ] Decide how disabled/uninstalled apps affect volumes.
- [ ] Add tests for selected-app backup/update state.

Exit criteria:

- V2 does not treat "detected old containers" as source of truth.
- Lifecycle behavior follows installed state and package contracts.

## Transfer Or Rebuild Inventory

Use this table to decide what to copy, rebuild, or ignore. Do not transfer anything just because it exists.

| Area | Old source | V2 action | Timing |
| --- | --- | --- | --- |
| Suite Manager UI primitives | `apps/suite-manager/frontend/src/components/ui.tsx` | Rebuild/copy selected primitives into `version-2/` | Phase 1 |
| Owner auth/session ideas | `apps/suite-manager/src/features/auth` | Rebuild around browser-created owner | Phase 1 |
| Old onboarding | `apps/suite-manager/src/features/onboarding` | Do not transfer wholesale; mine for app helper ideas later | Phase 8 |
| Homepage customization | `apps/suite-manager/src/features/homepage-config` | Rebuilt narrowly around V2 file ownership and system-agent contracts | Phase 5 |
| Host-agent capability patterns | `apps/suite-manager/src/features/service-agent` | Rebuild narrow client once V2 needs host actions | Phase 5 |
| DigitalOcean smoke harness | `scripts/smoke/digitalocean.cjs` | Adapt or wrap for V2; do not run automatically | Phase 4 |
| Installer convergence scripts | `scripts/selfhost/*`, `deploy/self-host/*` | Rebuild V2 bootstrap contract, borrow shell details carefully | Phase 3 |
| Compose helpers | `scripts/mos-compose.cjs`, `deploy/vps/docker-compose.yml` | Reference only until V2 projection/apply design exists | Phase 2+ |
| App catalog prototype | `feat/app-catalog-provisioning` | Reference for package/projection lessons only | Phase 6+ |
| Backup agent | `agents/selfhost/backup` | Defer until installed-app state exists | Phase 9 |
| Update agent | `agents/selfhost/update` | Defer or show capability only | Phase 5/9 |
| Caddy local HTTPS | existing Caddy/settings work | Defer until control-plane install is stable | Phase 5 |
| Branding sync | `branding/`, `scripts/sync-branding.cjs` | Rebuild locally under `version-2/branding` and `version-2/scripts/sync-branding.cjs` | Phase 1 |

## V2 Folder Shape

Current:

```text
version-2/
  README.md
  package.json
  apps/
    README.md
  branding/
    README.md
    styles/
      mos.css
    fonts/
    favicons/
  infrastructure/
    README.md
    homepage/
      custom.css
  scripts/
    README.md
    sync-branding.cjs
  site/
    README.md
    generated/
      branding/
        mos.css
  suite-manager/
    README.md
    frontend/
      src/
        styles/
          mos.css
    backend/
      src/
        auth/
        server/
        setup/
        state/
        platform-contract.cjs
      test/
        http-app.test.cjs
        platform-contract.test.cjs
        setup-service.test.cjs
  system-agents/
    README.md
```

Likely next shape:

```text
version-2/
  suite-manager/
    backend/
    frontend/
    shared/
  apps/
    <app-id>/
  infrastructure/
    caddy/
    compose/
    docker/
    projections/
  scripts/
    smoke/
    installers/
  system-agents/
    service/
    update/
    backup/
    restore/
```

This shape is not final. Let implementation pressure decide, but keep V2 self-contained.

## Testing Strategy

Use layered validation:

- Contract tests: cheap checks for architecture promises.
- Unit tests: state, auth, validation, projection functions.
- API tests: first-run status, owner creation, sessions.
- UI tests: only once the first-run screen exists.
- Installer render tests: no owner credentials required.
- DigitalOcean smoke: user-run paid validation.
- E2E: user-run noisy browser validation.

Agents may run:

```powershell
cmd /c npm --prefix version-2 test
```

Agents should ask the user to run:

```powershell
npm run smoke:do:reset
npm run e2e:onboarding
```

## Definition Of Done For The First Milestone

- `version-2/` contains a runnable Suite Manager-first control-plane app.
- Fresh empty state leads to browser owner creation.
- Owner credentials are not collected by the installer.
- Owner creation signs the user in.
- Control-plane dashboard works with no optional apps.
- DigitalOcean smoke can validate fresh install readiness.
- E2E can validate the owner creation flow.
- No optional app install code is required for milestone completion.

## Parking Lot

These are important but not first-milestone work:

- App catalog UI.
- Multi-app package catalog browsing.
- Migration from the first app lifecycle to richer app-specific setup helpers.
- Backup inclusion by app.
- Managed update inclusion by app.
- Migration from legacy all-app installs.
- Railway/platform V2 strategy.
