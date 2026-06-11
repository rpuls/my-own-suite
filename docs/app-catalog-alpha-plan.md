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
