# App Catalog Alpha Plan

This is a temporary development plan for the alpha epic that moves MOS from a preloaded suite install to a control-plane-first install with user-selected apps. Before this branch merges, convert active work into GitHub Issues and either remove this file or replace it with pointers to the issues and the durable decision in `docs/decisions.md`.

## Session Progress Tracker

Use this section as the first stop when resuming the epic in a new chat session. Keep it current when a slice lands, especially when a completed slice leaves old code or assumptions that must be removed later.

### Last Verified Manual State

- [x] DigitalOcean control-plane-first smoke passed: fresh cloud install, Suite Manager login, catalog dialog load, Stirling PDF install, host-agent Compose apply, Homepage restart, and Stirling PDF route reachability.
- [x] A follow-up DigitalOcean test after the Caddy reload fix passed: installing Stirling PDF added the Homepage tile, catalog UI showed installed, and the app launched from Homepage.
- [x] DigitalOcean smoke harness has a faster existing-Droplet reset path through `npm run smoke:do:reset`. Agents must not run `smoke:do:up` or `smoke:do:reset` automatically.

### Completed

- [x] Defined the clean alpha direction: fresh installs are control-plane-first, legacy all-app dev state is manually patched, and generated runtime files are projections rather than source of truth.
- [x] Added catalog manifests and validation for the current app inventory and control-plane components.
- [x] Added Suite Manager-owned installed app state in `installed-apps.json`.
- [x] Added authenticated app catalog API and reusable catalog picker in the Customize flow.
- [x] Implemented the first install MVP with Stirling PDF.
- [x] Fixed successful host apply consistency: app state ends as `installed` with `lastApply.status: succeeded`, and the final generated Compose selection is synced back to the service agent.
- [x] Reconciled generated Compose selection from Suite Manager installed state on catalog reads.
- [x] Made seeded Homepage defaults control-plane-first in both Suite Manager and Homepage bundled config.
- [x] Made `vps:up` default to control-plane-only when no catalog selection exists, with `--allProfiles` kept as an explicit development override.
- [x] Generated optional app Caddy routes from installed catalog selection and app manifest route metadata.
- [x] Updated the self-host service agent so catalog apply refreshes and reloads Caddy routes.
- [x] Introduced catalog app package directories for converted apps, with Stirling PDF and Radicale moved under `apps/suite-manager/catalog/apps/<app-id>/manifest.json`.
- [x] Added package-owned projection support for selected app env writes, internal Caddy snippets, richer Homepage YAML contributions, and setup-helper entry points.
- [x] Moved Radicale's internal iCal bridge and Homepage calendar contribution into the Radicale catalog package, and removed Radicale from default suite-level onboarding.
- [x] Moved Radicale's setup-helper UI and password handoff under the Radicale package, and added a guardrail test that fails if converted app behavior leaks back into suite-level onboarding, static Caddy routes, or global Homepage env defaults.
- [x] Made converted app installability, setup-helper modules, and VPS doctor checks manifest-driven so Stirling PDF and Radicale no longer need app-name branches in the install route, setup-helper registries, or converted-app doctor validation.

### Current Next Slice

- [ ] Convert the next app package using the package-directory contract before migrating more hardcoded app behavior.
- [ ] Continue reducing old global env/url projections for unconverted apps as each app moves into a package.
- [ ] Add broader app lifecycle tests once uninstall/disable semantics are defined.

### Cleanup Debt Created By Completed Slices

These are known old-system leftovers that should be cleaned as the catalog model absorbs each app:

- [x] `deploy/vps/Caddyfile` no longer contains the static internal Radicale iCal bridge; selected package snippets are generated into the internal app routes projection.
- [ ] `scripts/vps-init.cjs` still writes app URL env values globally for unconverted apps. Keep what is needed for current placeholders, but move app-specific derived env/url generation into catalog package handling as apps are converted.
- [x] `scripts/vps-doctor.cjs` reads converted app doctor contracts from installed package manifests for Stirling PDF and Radicale.
- [ ] `scripts/vps-doctor.cjs` still validates unconverted current app env files regardless of installed catalog state. Continue moving validation into package `doctor` contracts as apps are converted.
- [ ] Suite Manager general onboarding still imports Vaultwarden, Seafile, and Immich steps. Extract app helpers into app install/setup flows as those apps are converted.
- [ ] `apps/suite-manager/src/config.ts` still exposes app-specific onboarding config such as Radicale credentials as part of general Suite Manager config. Move app-specific config access behind app package/helper boundaries.
- [x] Generic app-catalog setup-helper registries now load package-declared backend modules and frontend panels for converted apps instead of branching on Radicale.
- [ ] `scripts/mos-updater-lib.cjs` still uses the historical all-profile list for update apply. Decide how managed updates should derive selected app profiles from installed catalog state.
- [ ] Backup inclusion still follows detected Docker state/rendered Compose rather than installed catalog state and manifest backup metadata.
- [ ] Installer and Suite Manager still require owner env values for now. The future owner/setup flow should create the owner account in the browser instead of collecting credentials before install.

### Deferred Or Out Of Scope For The Current Slice

- [ ] Do not add Docker/container detection or migration tooling for pre-catalog all-app installs.
- [ ] Do not redesign all onboarding while extracting Radicale. Only remove Radicale-specific assumptions from suite-level onboarding.
- [ ] Do not implement uninstall/disable semantics until the installed app state and package projection model are stable.
- [ ] Do not change Railway/platform deployment strategy in this epic unless a narrow compatibility fix is required.
- [ ] Do not replace Homepage YAML with a proprietary dashboard registry. Homepage YAML remains the user-facing layout source.

### Suggested Next Session Prompt

Continue the app catalog alpha epic on `feat/app-catalog-provisioning`. Start from `docs/app-catalog-alpha-plan.md`, especially **Session Progress Tracker** and **Current Next Slice**. Use the package-directory contract established by Stirling PDF and Radicale before migrating more hardcoded apps: converted apps declare `lifecycle.installable`, env projections, routes, Homepage contributions, `doctor` checks, and setup-helper backend/frontend modules in their package. Do not add new app-name branches to install routes, setup-helper registries, Caddy/Homepage defaults, or `vps-doctor`. Keep the changelog folded into the existing app-catalog alpha entry.

## Goal

Install the MOS control plane first, then let the owner choose apps from Suite Manager.

The self-host installer should create a working machine with:

- Suite Manager
- Homepage
- Caddy
- Host agents needed for updates, backups, restore, service changes, and Caddy apply actions

The installer should not need the future owner email or owner password. The owner account should be created in Suite Manager on first visit, and app-specific provisioning should happen when an app is added from the catalog.

## Product Shape

1. User installs MOS on own hardware or a cloud server.
2. First browser visit opens Suite Manager setup.
3. User creates the MOS owner account.
4. User lands in the existing customization-oriented experience.
5. User adds apps from a catalog.
6. Suite Manager updates Homepage YAML, Caddy generated config, Docker Compose inputs, app env files, and host agents as needed.
7. App-specific setup helpers appear only for apps that need them.

This keeps the default install lean and makes the suite feel owned by the user instead of preloaded with choices the project made for them.

## Why This Matters

- The USB and cloud installers no longer need to collect owner credentials before first boot.
- New users are not greeted by a bundle of apps they may not want.
- App growth becomes easier because new apps can be added to the catalog without making every install heavier.
- Existing Suite Manager customization work becomes the foundation for a friendlier app lifecycle UI.
- App credential decisions move to the moment the user installs that app, where context is clearer.
- Future cloud and own-hardware installs can stay closer to the same flow.

## Non-Goals

- Do not support more host operating systems. Alpha self-host remains Ubuntu Server 24.04 LTS only.
- Do not make Suite Manager a general-purpose shell or unrestricted host admin panel.
- Do not require every app to support perfect automated user provisioning before it can exist in the catalog.
- Do not redesign Homepage as a proprietary dashboard system. Homepage YAML remains the user-facing layout source.
- Do not remove Railway in this epic. Platform installs remain secondary and can keep using their own simple path until migrated deliberately.
- Do not add source-level migration tooling for the single legacy development server that predates the app catalog. This epic should leave clean catalog-first source code; old dev state can be patched manually when needed.

## Current Alpha Status

A DigitalOcean smoke test on this branch passed the control-plane-first path: fresh cloud install, Suite Manager login, catalog dialog load, Stirling PDF install, host-agent Compose apply, Homepage restart, and Stirling PDF route reachability.

During that test, the Suite Manager image was fixed to include `catalog/` in commit `b6eefdf` (`Include-catalog-in-suite-manager-image`).

Completed since that smoke test:

- Successful host apply now marks the app `installed` with `lastApply.status: succeeded`, regenerates Compose selection from Suite Manager state, and syncs the final projection back to the host agent without rerunning Compose.
- Catalog reads reconcile generated Compose selection from `installed-apps.json`, so local and host-owned generated selection files can be restored from Suite Manager state.
- Seeded Homepage defaults are now control-plane-first. Catalog app tiles are added only by catalog install flows.
- `vps:up` now defaults to control-plane-only when no catalog selection exists. `--allProfiles` remains as an explicit full-stack development override.
- `vps:init` now generates built-in Caddy app routes from installed catalog selection. Suite Manager and Homepage routes are always generated; optional app routes appear only for installed or pending-apply catalog apps.

Current follow-ups:

- Move app-specific env rendering, setup helpers, Homepage contributions, and route extras fully into catalog-owned app packages. Radicale's internal iCal bridge, calendar widget YAML, and assisted setup helper belong to the Radicale package, not the default Caddy/Homepage/control-plane route set.
- Old onboarding still assumes bundled apps exist and should be redesigned later. For the next Radicale slice, only extract the Radicale-specific helper enough that general onboarding no longer depends on Radicale being installed.
- The first owner/setup flow still needs to stop treating installer-time owner credentials as the long-term model.
- Uninstall/disable semantics remain undefined for alpha.
- Backup inclusion still needs to follow installed catalog state.
- Legacy all-app development installs are manually patched during this epic rather than driving migration code into the catalog implementation.

## Target Architecture

### Control Plane

The default MOS runtime includes only the components required to manage the suite:

- Suite Manager for setup, app catalog, customization, updates, backups, restore, and settings.
- Homepage as the user-facing dashboard.
- Caddy for built-in routes and user-managed app routes.
- Repo-owned host agents for controlled host actions.

### App Catalog

Each catalog app should have a repo-owned package under `apps/suite-manager/catalog/apps/<app-id>/` with a `manifest.json` that describes:

- Display name, description, icon, category, and app docs link.
- Docker Compose service fragments or a reference to service templates.
- Required env fields and generated secrets.
- Persistent volumes.
- Caddy route needs.
- Homepage tile defaults.
- Package-owned Homepage YAML contributions when a simple tile is not enough.
- Package-owned doctor checks for installed-app env validation.
- Install, uninstall, restart, and status behavior.
- Optional provisioning helpers with package-owned backend and frontend modules.
- Backup and restore inclusion rules.

The manifest should be data-first. App-specific code is allowed only when the app truly needs a special setup helper or validation extension, and that code should live under the app package with a manifest reference. Generic Suite Manager files should load package-declared extension points instead of branching on app IDs.

Converted apps may keep Dockerfiles, service env templates, app READMEs, and public docs in their existing compatibility locations, but the catalog package must be the place that declares which of those assets belong to the app lifecycle.

### Compose Management

Suite Manager needs a safe way to enable and disable repo-owned app services without hand-editing the canonical developer Compose file.

Preferred direction:

- Keep `deploy/vps/docker-compose.yml` as the developer/local substrate for now.
- Generate an own-infra Compose override or assembled Compose file from selected catalog apps.
- Keep generated files clearly marked and ignored when appropriate.
- Preserve repo-owned image/build contracts and `.env.template` files.
- Run validation before applying changes.

The app catalog should not mutate arbitrary user-authored Compose snippets in the first version.

### Caddy Management

Suite Manager already manages generated Caddy snippets for Homepage-managed routes. The catalog should reuse that path.

Current split:

- Control-plane routes are always generated for Suite Manager and Homepage.
- Built-in optional app routes are generated from installed catalog selection and app manifest `routes`.
- User/external proxy routes continue to come from Homepage YAML `mos.proxy` annotations.
- Generated Caddy files remain runtime projections, not source of truth.

When installing an app, Suite Manager should:

- Add or update the managed Homepage tile.
- Add or update structured `mos.proxy` metadata when the app needs a route.
- Regenerate the Caddy snippet.
- Ask the self-host service agent to validate and reload Caddy when available.

### Homepage Management

Homepage YAML remains the user-facing layout source.

When installing an app, Suite Manager should:

- Add the app tile to a sensible group.
- Preserve user ordering and customization where possible.
- Avoid overwriting manually edited tiles unless they are clearly Suite Manager-managed.

### Owner Setup

The installer should stop requiring `OWNER_EMAIL` and `OWNER_PASSWORD`.

Suite Manager first-run setup should:

- Create the MOS owner account.
- Persist owner identity in Suite Manager state.
- Unlock the app catalog and customization flows.
- Record whether setup has completed.

Any app that needs owner information should request reuse of the MOS owner identity during that app's install flow.

### App Provisioning

App provisioning should be app-specific and honest about what is possible.

Provisioning modes:

- Automatic: Suite Manager can seed credentials or call a supported setup path.
- Assisted: Suite Manager displays a helper flow and writes the app env/config, but the user completes an in-app step.
- Manual: Suite Manager installs the app and opens app-native setup with clear guidance.
- Unsupported for alpha: apps that cannot be installed safely yet stay hidden or marked experimental.

Existing onboarding helpers should be audited and extracted into app install helpers where useful.

## Implementation Phases

### Phase 1: Inventory And Contracts

- Inventory current default apps, services, env files, volumes, Caddy routes, Homepage tiles, onboarding steps, and backup behavior.
- Identify which apps can be installed without owner credentials.
- Identify which apps need owner email, owner password, or manual first-run setup.
- Define the first catalog manifest schema.
- Define installed-app state storage in Suite Manager.
- Define generated Compose output and validation commands.

Exit criteria:

- A short manifest proposal exists.
- Each current app has a provisioning classification.
- The first alpha default app set is agreed: Suite Manager, Homepage, Caddy only.

### Phase 2: Control-Plane-Only Bootstrap

- Make self-host bootstrap start only Suite Manager, Homepage, Caddy, and required host agents by default.
- Remove owner credential requirements from USB and cloud installer generation.
- Keep compatibility for existing installs that already have owner env values.
- Make first Suite Manager visit create the MOS owner.
- Update installer docs and public storytelling for the lean control-plane install.

Exit criteria:

- Fresh USB/cloud install reaches Suite Manager without owner values in the installer seed.
- Owner creation happens in the browser.
- Existing installs are not broken by missing new catalog state.

### Phase 3: Catalog MVP

- Add a Suite Manager app catalog page or integrate catalog install into the existing Customize flow.
- Support installing one low-risk app end to end.
- Generate or update app env files.
- Enable selected Compose services through the new generated Compose path.
- Add Homepage tile and Caddy route through existing managed paths.
- Show install status and useful errors.

Good first app candidates:

- Vaultwarden if the current setup helper can be extracted cleanly.
- A simpler stateless or low-state app if Vaultwarden setup is still too credential-heavy.

Exit criteria:

- A fresh control-plane install can add one catalog app without terminal work.
- Re-running the install/apply flow is idempotent.
- Removing or disabling the app has a clear first-version behavior.

### Phase 4: Extract Existing Onboarding Helpers

- Audit current onboarding flow and split app-specific logic from suite-level owner setup.
- Move useful app helpers into per-app install/setup flows.
- Keep advanced details behind disclosures.
- Preserve non-technical user value: generated credentials, copy buttons, direct links, status checks, and clear next actions.

Exit criteria:

- Suite-level onboarding is only owner/setup state.
- App-specific onboarding appears when installing or configuring that app.
- At least two current app helpers work from catalog install flows.

### Phase 5: Expand Catalog And Lifecycle

- Add install flows for the remaining current default apps.
- Add app status, restart, update inclusion, backup inclusion, and uninstall/disable semantics.
- Add validation tests for generated Compose, Caddy, Homepage YAML, and env files.
- Update public docs and app technical references.

Exit criteria:

- The old preloaded-app default can be retired for fresh installs.
- Users can install the previous default app set from Suite Manager.
- Backups and managed updates understand selected apps.

## Migration Strategy

For this alpha branch, prioritize the clean target architecture over compatibility scaffolding for pre-catalog development installs.

Fresh installs use Suite Manager installed-app state as the source of truth, and generated runtime files are derived from that state. The single known legacy development server can be manually patched if needed. Do not add Docker/container detection, Homepage-default inference, or migration framework code just to preserve old all-app state.

Fresh installs can use the new lean default once the catalog MVP is reliable.

## Open Questions

- Should generated Compose remain profile-based for the next alpha step, or graduate to an override/assembled file when app packages need service-level additions beyond profiles?
- What is the minimum uninstall story for alpha: disable route, stop service, remove generated config, preserve volumes?
- How should app backup inclusion be represented before all apps have rich catalog metadata?
- Should cloud installs default to public domain guidance, while own-hardware defaults to local-only?

## Current Inventory Snapshot

This snapshot maps the current preloaded suite into the surfaces a catalog manifest will need to own. It is intentionally compact; the app READMEs remain the source of truth for technical details.

### Control Plane

| Component | Compose services | Env templates | Volumes | Routes and Homepage | First-run behavior |
| --- | --- | --- | --- | --- | --- |
| Caddy | `caddy` | `.env`, `services/caddy/.env.template` | `caddy_data`, `caddy_config` | Imports generated built-in routes and external proxy routes. Suite Manager/Homepage routes are always generated; optional app routes come from installed catalog selection. | Must be present for all routed installs. |
| Homepage | `homepage` | `.env`, `services/homepage/.env.template` | `homepage_images`; Docker socket read-only | Dashboard source is `services.template.yaml`; runtime config is fetched from Suite Manager and generated to `services.yaml`. | Must be present for dashboard and user-facing layout. |
| Suite Manager | `suite-manager` | `.env`, `services/suite-manager/.env.template`, app env files for current onboarding helpers | `suite_manager_data` | Homepage tile points to `${SUITE_MANAGER_URL}/setup/`; app serves setup/customize/updates/backups/settings under `/setup`. | Currently requires `OWNER_EMAIL`, `OWNER_PASSWORD`, and `SESSION_SECRET` before process start. |
| Host agents | `mos-update-agent`, `mos-service-agent`, `mos-backup-agent` systemd services outside Compose | Reconciled by `agents/selfhost/reconcile-host-agents.sh`; Compose self-host override mounts sockets/tokens into Suite Manager. | Agent state under `/var/lib` and sockets under `/run`. | Service agent can apply generated external Caddy routes and local HTTPS settings; update agent applies managed updates; backup agent snapshots/restores stack state. | Required capabilities are detected by Suite Manager rather than assumed. |

### Current Bundled Apps

| App | Compose services/profile | Env templates | Volumes | Routes and Homepage tile | Current onboarding/setup | Provisioning classification |
| --- | --- | --- | --- | --- | --- | --- |
| Vaultwarden | `vaultwarden`, `vaultwarden-postgres`; profile `vaultwarden` | `services/vaultwarden/.env.template`, `services/vaultwarden-postgres/.env.template`, shared SMTP inputs from Suite Manager env | `vaultwarden_data`, `vaultwarden_postgres_data` | Built-in Caddy route `vaultwarden.${DOMAIN}` uses HTTPS even in HTTP mode; Homepage tile uses `${VAULTWARDEN_URL}`. | Suite Manager asks the user to open Vaultwarden signup with `OWNER_EMAIL`, detects account creation through the Vaultwarden database, then guides import of generated suite credentials. | Assisted. Service/env can be generated automatically, but owner account creation is app-native and currently tied to onboarding. Good MVP candidate only if this helper is extracted carefully. |
| Seafile | `seafile`, `seafile-mysql`, `seafile-valkey`; profile `seafile` | `services/seafile/.env.template`, `services/seafile-mysql/.env.template`, `services/seafile-valkey/.env.template`, shared SMTP inputs | `seafile_data`, `seafile_mysql_data` | Built-in route `seafile.${DOMAIN}`; Homepage tile uses `${SEAFILE_URL}`. ONLYOFFICE integration uses `${ONLYOFFICE_APIJS_URL}`. | Env seeds `INIT_SEAFILE_ADMIN_EMAIL` from `OWNER_EMAIL` and generates `INIT_SEAFILE_ADMIN_PASSWORD`; Suite Manager currently tells the user to sign in with imported Vaultwarden credentials. | Automatic-plus-assisted. Service/env/bootstrap admin can be generated, but it depends on MOS owner identity and credential handoff. |
| ONLYOFFICE | `onlyoffice`; profile `onlyoffice` | `services/onlyoffice/.env.template` | `onlyoffice_data` | Built-in route `onlyoffice.${DOMAIN}`; no default Homepage tile. | No Suite Manager onboarding step; primarily installed as Seafile document-editing integration. | Automatic dependency app. Should usually be installed as part of Seafile or offered as an advanced dependency. |
| Stirling PDF | `stirling-pdf`; profile `stirling-pdf` | `services/stirling-pdf/.env.template` | `stirling_pdf_training_data`, `stirling_pdf_extra_configs`, `stirling_pdf_custom_files`, `stirling_pdf_logs`, `stirling_pdf_pipeline` | Built-in route `stirling-pdf.${DOMAIN}`; Homepage tile uses `${STIRLING_PDF_URL}`. | No current Suite Manager onboarding step. | Automatic. Low-risk MVP candidate because it has no owner credential dependency and a simple health endpoint. |
| Radicale | `radicale`; profile `radicale` | `services/radicale/.env.template`, `services/homepage/.env.template`, Caddy consumes Radicale env for the internal iCal bridge | `radicale_data` | Built-in route `radicale.${DOMAIN}`; Homepage Calendar tile uses `${RADICALE_URL}` and backend-only `${RADICALE_ICAL_URL}` via Caddy bridge. Unlike simple app tiles, Radicale also needs Homepage widget/layout YAML so the calendar experience is useful immediately after install. | Env generates admin username/password and iCal bridge token; Suite Manager currently guides manual device connection as part of the general onboarding flow after Vaultwarden credential import. That helper should move into a Radicale-owned post-install/setup flow shown after Radicale install or from the installed app details screen. | Assisted. Service/env can be generated automatically, but user value depends on a device setup helper, generated calendar credentials, the iCal bridge, and Homepage widget contribution. |
| Immich | `immich`, `immich-machine-learning`, `immich-postgres`, `immich-valkey`; profile `immich` | `services/immich/.env.template`, `services/immich-machine-learning/.env.template`, `services/immich-postgres/.env.template`, `services/immich-valkey/.env.template` | `immich_upload`, `immich_model_cache`, `immich_db` | Built-in route `immich.${DOMAIN}`; Homepage tile uses `${IMMICH_URL}`. | Suite Manager only opens Immich and tells the user to finish the app-native first-run wizard if prompted. | Manual/assisted. Install can be automated, but first user setup remains app-native and resource-heavy. |

### Cross-Cutting Runtime Surfaces

- `deploy/vps/docker-compose.yml` uses profiles for optional app services.
- `scripts/vps-run.cjs` starts only the control plane by default when no catalog selection exists, consumes selected profiles from `deploy/vps/generated/app-catalog/compose-selection.json` when present, and keeps `--allProfiles` as an explicit development override.
- `scripts/vps-init.cjs` renders every service env template for now, but built-in Caddy app routes are derived from installed catalog selection instead of a static all-app list.
- `scripts/vps-doctor.cjs` validates converted app env files from installed package `doctor` contracts, while unconverted current apps still use the older global validation path.
- Homepage defaults should be control-plane-first. Catalog app tiles should be added by install flows, not seeded as bundled defaults.
- Caddy built-in route generation is split: control-plane routes are always generated, optional app routes come from installed catalog state, and external user-managed routes come from Homepage `mos.proxy` annotations.
- The backup agent snapshots detected MOS Docker volumes and records the rendered Compose configuration plus the profiles it restarts. Catalog state should become part of the backed-up Suite Manager state before selective installs become the default.

## First Manifest Proposal

The catalog manifest should be data-first and small enough to review alongside each app. A practical first shape:

`apps/suite-manager/catalog/apps/stirling-pdf/manifest.json` shape:

```yaml
id: stirling-pdf
name: Stirling PDF
category: tools
summary: Handle everyday PDF jobs without uploading personal documents elsewhere.
docs:
  app: /docs/apps/stirling-pdf
compose:
  profile: stirling-pdf
  services:
    - stirling-pdf
  envTemplates:
    - deploy/vps/services/stirling-pdf/.env.template
  volumes:
    - stirling_pdf_training_data
    - stirling_pdf_extra_configs
    - stirling_pdf_custom_files
    - stirling_pdf_logs
    - stirling_pdf_pipeline
lifecycle:
  installable: true
env:
  projections:
    - serviceEnv: services/homepage/.env
      key: STIRLING_PDF_URL
      value: ${PUBLIC_URL_SCHEME}://stirling-pdf.${DOMAIN}
routes:
  public:
    - host: stirling-pdf
      upstream: stirling-pdf:8080
  internal: []
homepage:
  tile:
    group: My Tools
    name: Stirling PDF
    hrefEnv: STIRLING_PDF_URL
    description: Handle everyday PDF jobs without uploading personal documents elsewhere
    icon: /images/stirling-pdf.png
  contributions:
    services: []
    widgets: []
provisioning:
  mode: automatic
  setupHelper: null
  postInstallActionLabel: null
doctor:
  serviceEnv: services/stirling-pdf/.env
  requiredEnv:
    - TZ
  homepageUrls:
    - key: STIRLING_PDF_URL
      host: stirling-pdf
  checks: []
backup:
  includeVolumes:
    - stirling_pdf_extra_configs
    - stirling_pdf_custom_files
    - stirling_pdf_pipeline
```

Initial package manifest fields:

- `id`, `name`, `category`, `summary`, `docs`, and optional `icon`.
- `compose.profile`, `compose.services`, `compose.envTemplates`, and `compose.volumes`.
- `lifecycle.installable` for alpha install enablement; do not add install allowlists in routes.
- `env.projections` for selected app URL/env writes into service env files.
- `routes.public` with app subdomain and internal upstream for generated built-in Caddy routes.
- `routes.internal` for package-owned generated Caddy snippets such as Radicale's iCal bridge.
- `homepage.tile` defaults, including group, name, description, icon, and generated URL env.
- `homepage.contributions` for package-owned Homepage YAML fragments when a simple tile is not enough.
- `env` metadata for required owner-supplied values, generated secrets, shared values, and derived values.
- `provisioning.mode`: `automatic`, `assisted`, `manual`, or `unsupported-alpha`.
- Optional `provisioning.setupHelper` object with `id`, package-relative `backend`, and package-relative `frontend` when an app needs assisted setup.
- Optional `doctor` contract for installed-app env files, required values, self-host Homepage URL checks, and narrow cross-env checks.
- `backup.includeVolumes` and later `restore.notes` so backup behavior is explicit.
- Optional `dependencies` for apps like Seafile requiring ONLYOFFICE as an install option or recommended companion.

Installed-app state should live in Suite Manager persistent state first, with generated env/Compose/Caddy/Homepage files treated as outputs. The state should record installed app id, manifest version, install status, selected options, generated secret references, installed service names, installed volumes, route hosts, Homepage tile identity, and last apply result. A generated file can mirror selected profiles for host tools, but the Suite Manager state should be the reconciliation source.

For the first generated Compose path, prefer an ignored own-infra selection file over mutating the developer Compose file. The least invasive alpha option is to generate a selected-profile file or command input consumed by `scripts/vps-run.cjs` and the host agents, then later graduate to a Compose override or assembled file when service-level additions/removals need more than profiles.

## Current Implementation State

Implemented after the successful DigitalOcean smoke test:

1. `installed-apps.json` is the Suite Manager-owned source of truth for optional catalog app lifecycle.
2. Compose selection JSON/YAML is regenerated from installed state after installs and on catalog reads.
3. The self-host service agent applies selected app services on install and can sync final generated selection without running Compose again.
4. Seeded Homepage defaults are control-plane-first. Catalog app tiles appear only after catalog install adds them.
5. Built-in Caddy routes are control-plane-first. Suite Manager/Homepage routes are always present; optional app routes come from installed catalog selection and manifest route metadata.
6. Legacy all-app migration code is intentionally absent. Pre-catalog development state is manually patched outside this branch.

Stirling PDF remains the first install MVP because it has one app service, no owner credential dependency, a simple route and Homepage tile, and no existing onboarding helper to untangle.

## Recommended Next Slice

Move app-specific runtime details that still leak through global templates into catalog-owned app package behavior, starting with Radicale.

Radicale package ownership should include:

- Public Radicale route generation.
- Internal Caddy iCal bridge route generation.
- `RADICALE_ICAL_URL` and related env/url generation needed by the bridge and Homepage calendar widget.
- The Homepage calendar tile/widget/layout YAML contribution. Radicale is not just a simple name/url/description tile; its useful default Homepage state includes calendar widget configuration that should be applied only when Radicale is installed.
- The Radicale assisted setup helper currently embedded in general onboarding. General onboarding should stop assuming Radicale exists. The Radicale helper should be reachable after successful catalog install and later from the installed app details/setup action.

Implementation boundaries:

- Keep default Caddy, Homepage, and env behavior focused on Suite Manager, Homepage, and Caddy only.
- Do not redesign all onboarding in this slice. Extract only the Radicale-specific setup flow needed to remove Radicale from suite-level onboarding.
- Do not introduce legacy all-app migration logic.
- Preserve Homepage YAML as the user-facing layout source. Catalog install may apply a managed Radicale YAML contribution, but should avoid replacing unrelated user customization.
- Keep simple catalog app tile behavior intact for apps like Stirling PDF.

Validation targets:

- A fresh control-plane-only install does not seed Radicale Homepage tiles/widgets.
- Uninstalled Radicale does not generate the public Radicale route or internal iCal bridge route.
- Installing Radicale generates the route(s), env/url projection, Homepage calendar contribution, and app-specific setup helper entry point.
- Re-running Radicale install/apply is idempotent and does not duplicate Homepage YAML.
- Existing Stirling PDF install behavior still works.

## Validation Gates

Before calling this alpha-ready:

- Fresh USB install reaches Suite Manager setup with no owner credentials in installer config.
- Fresh cloud install reaches the same Suite Manager setup.
- Owner creation works from the browser.
- Installing each catalog app does not require SSH.
- Generated Compose validates before apply.
- Generated Caddy validates before reload.
- Homepage config remains editable and recoverable.
- Managed update still refreshes host agents and catalog logic.
- Backup and restore behavior is explicit for installed apps.
- Railway still works or is clearly documented as a secondary platform path with separate limitations.

## First Next Step

The original inventory and first MVP path are complete enough for continuation. The next chat session should start from **Session Progress Tracker**, then use **Recommended Next Slice** for the Radicale package work.
