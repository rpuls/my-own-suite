# App Catalog Alpha Plan

This is a temporary development plan for the alpha epic that moves MOS from a preloaded suite install to a control-plane-first install with user-selected apps. Before this branch merges, convert active work into GitHub Issues and either remove this file or replace it with pointers to the issues and the durable decision in `docs/decisions.md`.

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

## Target Architecture

### Control Plane

The default MOS runtime includes only the components required to manage the suite:

- Suite Manager for setup, app catalog, customization, updates, backups, restore, and settings.
- Homepage as the user-facing dashboard.
- Caddy for built-in routes and user-managed app routes.
- Repo-owned host agents for controlled host actions.

### App Catalog

Each catalog app should have a repo-owned manifest that describes:

- Display name, description, icon, category, and app docs link.
- Docker Compose service fragments or a reference to service templates.
- Required env fields and generated secrets.
- Persistent volumes.
- Caddy route needs.
- Homepage tile defaults.
- Install, uninstall, restart, and status behavior.
- Optional provisioning helpers.
- Backup and restore inclusion rules.

The manifest should be data-first. App-specific code is allowed only when the app truly needs a special setup helper.

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

Existing installs may already have all current apps running. They should not be forcibly reduced.

Migration should:

- Detect existing services and mark them as installed catalog apps where possible.
- Preserve existing Homepage tiles and Caddy routes.
- Preserve existing env files, secrets, and volumes.
- Avoid uninstalling anything automatically.
- Give Suite Manager a reconciliation screen if catalog state and actual Compose state disagree.

Fresh installs can use the new lean default once the catalog MVP is reliable.

## Open Questions

- Should catalog state live in Suite Manager's existing persistent state, generated YAML, or both?
- Should generated Compose be an override file, a full assembled file, or profile-based selection?
- Which current app is the best first MVP install?
- What is the minimum uninstall story for alpha: disable route, stop service, remove generated config, preserve volumes?
- How should app backup inclusion be represented before all apps have rich catalog metadata?
- Should cloud installs default to public domain guidance, while own-hardware defaults to local-only?

## Current Inventory Snapshot

This snapshot maps the current preloaded suite into the surfaces a catalog manifest will need to own. It is intentionally compact; the app READMEs remain the source of truth for technical details.

### Control Plane

| Component | Compose services | Env templates | Volumes | Routes and Homepage | First-run behavior |
| --- | --- | --- | --- | --- | --- |
| Caddy | `caddy` | `.env`, `services/caddy/.env.template`, `services/radicale/.env.template` | `caddy_data`, `caddy_config` | Imports generated built-in routes and external proxy routes; also hosts the internal Radicale iCal bridge. | Must be present for all routed installs. |
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
| Radicale | `radicale`; profile `radicale` | `services/radicale/.env.template`, `services/homepage/.env.template`, Caddy consumes Radicale env for the internal iCal bridge | `radicale_data` | Built-in route `radicale.${DOMAIN}`; Homepage Calendar tile uses `${RADICALE_URL}` and backend-only `${RADICALE_ICAL_URL}` via Caddy bridge. | Env generates admin username/password and iCal bridge token; Suite Manager guides manual device connection after Vaultwarden credential import. | Assisted. Service/env can be generated automatically, but user value depends on a device setup helper and credential handoff. |
| Immich | `immich`, `immich-machine-learning`, `immich-postgres`, `immich-valkey`; profile `immich` | `services/immich/.env.template`, `services/immich-machine-learning/.env.template`, `services/immich-postgres/.env.template`, `services/immich-valkey/.env.template` | `immich_upload`, `immich_model_cache`, `immich_db` | Built-in route `immich.${DOMAIN}`; Homepage tile uses `${IMMICH_URL}`. | Suite Manager only opens Immich and tells the user to finish the app-native first-run wizard if prompted. | Manual/assisted. Install can be automated, but first user setup remains app-native and resource-heavy. |

### Cross-Cutting Runtime Surfaces

- `deploy/vps/docker-compose.yml` already uses profiles for app services, but `scripts/vps-run.cjs` currently starts every app profile by default.
- `scripts/vps-init.cjs` renders every service env template and always generates Caddy built-in routes for all current app hosts.
- `scripts/vps-doctor.cjs` validates all current app env files regardless of whether their profiles are selected.
- `scripts/vps-run.cjs` now has a generated app-catalog selection point: when `deploy/vps/generated/app-catalog/compose-selection.json` exists, selected profiles come from that file; otherwise the existing all-app profile behavior remains.
- Homepage tiles are currently pruned by missing env placeholders, but `services/homepage/.env.template` generates URLs for every bundled app.
- Caddy built-in route generation is currently static for every bundled app route, with external user-managed routes handled separately through Homepage `mos.proxy` annotations.
- The backup agent snapshots detected MOS Docker volumes and records the rendered Compose configuration plus the profiles it restarts. Catalog state should become part of the backed-up Suite Manager state before selective installs become the default.

## First Manifest Proposal

The catalog manifest should be data-first and small enough to review alongside each app. A practical first shape:

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
routes:
  - host: stirling-pdf
    upstream: stirling-pdf:8080
homepage:
  group: My Tools
  name: Stirling PDF
  hrefEnv: STIRLING_PDF_URL
  description: Handle everyday PDF jobs without uploading personal documents elsewhere
  icon: /images/stirling-pdf.png
provisioning:
  mode: automatic
  setupHelper: none
backup:
  includeVolumes:
    - stirling_pdf_extra_configs
    - stirling_pdf_custom_files
    - stirling_pdf_pipeline
```

Initial manifest fields:

- `id`, `name`, `category`, `summary`, `docs`, and optional `icon`.
- `compose.profile`, `compose.services`, `compose.envTemplates`, and `compose.volumes`.
- `routes` with app subdomain and internal upstream for generated built-in Caddy routes.
- `homepage` tile defaults, including group, name, description, icon, and generated URL env.
- `env` metadata for required owner-supplied values, generated secrets, shared values, and derived values.
- `provisioning.mode`: `automatic`, `assisted`, `manual`, or `unsupported-alpha`.
- Optional `provisioning.setupHelper` that points to a Suite Manager helper only when needed.
- `backup.includeVolumes` and later `restore.notes` so backup behavior is explicit.
- Optional `dependencies` for apps like Seafile requiring ONLYOFFICE as an install option or recommended companion.

Installed-app state should live in Suite Manager persistent state first, with generated env/Compose/Caddy/Homepage files treated as outputs. The state should record installed app id, manifest version, install status, selected options, generated secret references, installed service names, installed volumes, route hosts, Homepage tile identity, and last apply result. A generated file can mirror selected profiles for host tools, but the Suite Manager state should be the reconciliation source.

For the first generated Compose path, prefer an ignored own-infra selection file over mutating the developer Compose file. The least invasive alpha option is to generate a selected-profile file or command input consumed by `scripts/vps-run.cjs` and the host agents, then later graduate to a Compose override or assembled file when service-level additions/removals need more than profiles.

## Proposed First Implementation Slice

Start with a no-service-install catalog foundation:

1. Add repo-owned catalog manifest files for current apps under `apps/suite-manager/catalog`, beginning with `stirling-pdf` plus control-plane metadata.
2. Add a Suite Manager backend loader that validates manifest ids, profiles, service names, env template paths, route hosts, Homepage tile defaults, and provisioning modes.
3. Add installed-app state storage in Suite Manager state with no UI mutation yet.
4. Generate selected Compose profile outputs from installed-app state without running Docker yet.
5. Teach `vps:doctor` or a new focused unit test to validate the catalog manifests against current Compose/env/Homepage contracts.
6. Keep `vps:up` behavior unchanged until the manifest loader and selected-app state are covered.

Recommended first install MVP after that foundation: Stirling PDF. It has one app service, no owner credential dependency, a simple route and Homepage tile, and no existing onboarding helper to untangle.

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

Start with an inventory PR or branch slice:

- Map current default apps to services, env files, volumes, routes, Homepage tiles, onboarding steps, backup needs, and provisioning mode.
- Draft the catalog manifest shape from that inventory.
- Choose the first app for the catalog MVP.
