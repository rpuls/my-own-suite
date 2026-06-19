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
- [ ] Build the polished V2 Suite Manager owner setup UI.

### Current Next Slice

Build the first real V2 vertical slice inside `version-2/`:

1. Replace the minimal HTML owner form with a real V2 UI shell.
2. Decide the V2 frontend stack and local dev command.
3. Add a login screen for existing-owner signed-out state.
4. Add logout and signed-in dashboard affordances.
5. Keep the API/state tests green while adding UI tests when the app shell exists.

### Latest Verified Command

```powershell
cmd /c npm --prefix version-2 test
```

Expected result: V2 contract tests pass.

Current result: 13 V2 tests pass, covering the contract, branding sync, setup state, owner creation, duplicate-owner protection, login, and the minimal HTTP API.

### Suggested Next Session Prompt

Continue the clean MOS V2 launch-platform branch on `feat/app-platform-v2-lab`. Start from `docs/app-platform-v2-lab-plan.md`. Keep new code inside `version-2/`; treat existing repo code and `feat/app-catalog-provisioning` as reference material only. V2 now has `suite-manager/`, `apps/`, `site/`, `scripts/`, `system-agents/`, `infrastructure/`, and canonical `branding/` ownership folders. Suite Manager backend has file-backed setup state, owner password hashing, session tokens, first-run owner creation API, and minimal HTML. Shared colors change in `version-2/branding/styles/mos.css` and sync through `npm --prefix version-2 run branding:sync`. The next slice is a real V2 Suite Manager UI shell for owner setup, signed-out login, logout, and signed-in dashboard affordances. Do not add app catalog behavior yet.

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
- [ ] Add a V2 README section for local development once the polished app shell exists.
- [ ] Add a V2 architecture note inside `version-2/` if the folder needs local technical detail.

Exit criteria:

- `npm --prefix version-2 test` passes.
- A new session can identify the next slice from this roadmap.

### Phase 1: Suite Manager First-Run Owner Setup

Goal: prove the human entry point before touching app installs.

- [ ] Choose the V2 frontend app stack inside `version-2/`.
- [x] Create a minimal Suite Manager web app shell.
- [x] Add first-run setup status: `needs-owner`, `signed-out`, `signed-in`.
- [x] Add persistent state storage for owner account metadata.
- [x] Add password hashing.
- [x] Add owner creation endpoint.
- [x] Add duplicate-owner protection.
- [x] Add login/session creation after owner creation.
- [x] Add signed-out login endpoint if not created as part of the owner flow.
- [x] Add session persistence and logout.
- [x] Add minimal first-run owner creation UI.
- [ ] Replace minimal first-run UI with polished V2 UI.
- [ ] Rebuild/copy only the needed shared UI primitives from the old Suite Manager.
- [ ] Add unit/API tests for setup status and owner creation.
- [ ] Add UI-level tests only when there is enough app surface to justify them.

Exit criteria:

- Starting V2 with empty state shows owner setup.
- Creating owner persists state and signs the user in.
- Refreshing after setup does not show owner creation again.
- Duplicate owner creation is rejected.
- Tests pass through `npm --prefix version-2 test`.

### Phase 2: Control-Plane Install Shape

Goal: define and test what "installed MOS V2 control plane" means before optional apps.

- [ ] Define control-plane components in V2 state/contract.
- [ ] Define required runtime env values for control-plane-only install.
- [ ] Define generated state paths.
- [ ] Define how Suite Manager discovers its public URL.
- [ ] Define Homepage role before app catalog exists.
- [ ] Define Caddy role before app catalog exists.
- [ ] Define host-agent capabilities needed for first milestone.
- [ ] Add tests for control-plane install contract.

Exit criteria:

- V2 can describe a control-plane install without optional apps.
- Owner credentials are not part of installer inputs.
- Required generated files are documented or represented in V2 code.

### Phase 3: Installer Front Doors

Goal: make cloud, USB, and SSH setup feed the same V2 bootstrap shape.

- [ ] Inventory old installer scripts for reusable behavior.
- [ ] Decide whether V2 gets new installer scripts under `version-2/` or thin adapters outside it.
- [ ] Build V2 cloud installer path first.
- [ ] Make owner email/password optional or absent in V2 install config.
- [ ] Keep domain/runtime inputs separate from owner account inputs.
- [ ] Add render tests for V2 installer config.
- [ ] Add a local dry-run command for installer generation.
- [ ] Update docs only after the V2 path is actually runnable.

Exit criteria:

- A cloud-machine install can boot V2 control plane without owner credentials.
- USB and SSH can follow the same bootstrap contract later without custom app logic.

### Phase 4: DigitalOcean Validation Loop

Goal: reuse the known smoke harness for real-machine confidence without letting it drive the architecture.

- [ ] Decide how the existing smoke harness calls a V2 installer/ref.
- [ ] Add V2 mode to the smoke harness or a V2 wrapper.
- [ ] Remove owner credential requirement for V2 smoke mode.
- [ ] Have smoke output the first-run Suite Manager URL.
- [ ] Add a smoke readiness check that does not require app installs.
- [ ] Add optional browser-owner-creation validation once E2E exists.

Exit criteria:

- User can run a fresh DigitalOcean smoke install of V2.
- Smoke validates control-plane readiness.
- Smoke does not install optional apps.
- Smoke does not require installer-time owner credentials.

### Phase 5: Control-Plane Operations

Goal: make the empty platform trustworthy before adding apps.

- [ ] Add update-track display or defer it explicitly.
- [ ] Add host-agent capability display or defer it explicitly.
- [ ] Add backup placeholder/guidance or defer it explicitly.
- [ ] Add settings needed for base domain / local HTTPS or defer it explicitly.
- [ ] Decide what the first dashboard should show before apps exist.
- [ ] Keep advanced diagnostics behind details/disclosures.

Exit criteria:

- A user with no apps installed still understands the platform state.
- Missing host capabilities are explained without terminal-first instructions.
- No app-specific UI appears.

### Phase 6: App Package Contract, No Installs Yet

Goal: design app packages after the control plane is real.

- [ ] Draft V2 app package folder shape.
- [ ] Define package manifest fields.
- [ ] Define package-owned setup helper boundaries.
- [ ] Define projection outputs: Compose, Caddy, Homepage, env, backup, update inclusion.
- [ ] Define install states.
- [ ] Define app dependency semantics.
- [ ] Define what uninstall means before implementing it.
- [ ] Add manifest validation tests.

Exit criteria:

- App packages can be validated without installing them.
- The package contract does not depend on old preloaded-suite assumptions.

### Phase 7: First App Install

Goal: install one low-risk app end to end after the control plane is proven.

- [ ] Pick the first app, likely Stirling PDF.
- [ ] Create package manifest.
- [ ] Generate required runtime projections.
- [ ] Apply Compose/Caddy/Homepage changes through a narrow V2 adapter.
- [ ] Show install status in Suite Manager.
- [ ] Add idempotency tests.
- [ ] Run user-driven DigitalOcean validation.

Exit criteria:

- Fresh V2 install can add one app without SSH.
- Re-running install is safe.
- Failure states are visible and recoverable.

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
| Homepage customization | `apps/suite-manager/src/features/homepage-config` | Defer; V2 first needs control-plane state | Phase 5+ |
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
npm run smoke:do:up
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
- App package schema.
- App install/uninstall.
- App-specific setup helpers.
- Backup inclusion by app.
- Managed update inclusion by app.
- Migration from legacy all-app installs.
- Railway/platform V2 strategy.
