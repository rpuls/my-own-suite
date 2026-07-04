# App Package Integrations Research

Temporary V2 research for `feat/app-platform-v2-lab`. Before this branch merges, convert durable architecture choices into `docs/decisions.md` and implementation follow-ups into GitHub Issues, then remove or replace this document with a pointer.

## Purpose

MOS V2 is becoming an app launch platform rather than a preloaded suite. The first app packages prove single-service, guided setup, generated secrets, Homepage widgets, and multi-service app runtimes, but they do not yet explain how compatible packages should discover and wire themselves together.

Seafile plus OnlyOffice is the first useful pressure test only because Seafile exists in the current V2 package set. The same problem should be solved for Nextcloud, ownCloud, or any future MOS file/content platform that can use a document editor. OnlyOffice Docs is not useful to a normal MOS user in isolation because a user needs some compatible file/content platform to create, store, open, and save documents. That platform does not have to be Seafile.

The design goal is a generic compatibility and integration model: packages declare what capabilities they provide, what capabilities they can consume, and how an approved relationship should be applied. Suite Manager should help the user choose a compatible combination and then wire it without manual tinkering or app-pair hardcoding.

## Evidence Summary

V1 ran Seafile and OnlyOffice as separate Docker Compose profile services on the shared `mos-network`. Caddy generated fixed public routes for both `seafile.<domain>` and `onlyoffice.<domain>`. The V1 env generator wrote Seafile's `ONLYOFFICE_APIJS_URL` from the configured OnlyOffice URL, defaulted `ONLYOFFICE_INTERNAL_SEAFILE_URL` to `http://seafile`, and left JWT wiring available through `ONLYOFFICE_JWT_SECRET` and OnlyOffice `JWT_SECRET`.

V1's Seafile entrypoint patched `seahub_settings.py` at startup for proxy settings, OnlyOffice settings, SMTP settings, and version-sensitive OnlyOffice callback/download behavior. That made the integration operational, but spread pair-specific knowledge across app entrypoints, env templates, init scripts, doctor scripts, Compose profiles, fixed Caddy route generation, and Suite Manager onboarding copy.

Current Seafile documentation treats OnlyOffice as an extension/integration: deploy an OnlyOffice server first, then configure Seahub with `ENABLE_ONLYOFFICE`, `ONLYOFFICE_APIJS_URL`, and `ONLYOFFICE_JWT_SECRET`. The same page notes that Seafile 12.0 forces OnlyOffice JWT verification and that communication is secured with a shared secret. The official ONLYOFFICE Docker documentation says `JWT_ENABLED` defaults to true and `JWT_SECRET` defaults to a random value if not supplied, which can break integrations after restarts; it recommends supplying a stable secret. Sources: [Seafile Admin Manual, OnlyOffice Integration](https://manual.seafile.com/latest/extension/only_office/) and [ONLYOFFICE Docs Docker installation](https://helpcenter.onlyoffice.com/docs/installation/docs-community-install-docker.aspx).

The important product conclusion is broader than Seafile: document-editor packages should be modeled as providers that need at least one compatible document source/storage consumer to be useful. The platform should optimize for many-to-many compatibility, not for a Seafile-specific add-on.

## V1 Findings

V1 ran Seafile as three Compose services:

- `seafile`, exposed publicly through Caddy.
- `seafile-mysql`, internal database service.
- `seafile-valkey`, internal Redis-compatible cache service.

V1 ran OnlyOffice as its own `onlyoffice` Compose profile service with a public Caddy route and persistent `/var/www/onlyoffice/Data` volume.

The Seafile-to-OnlyOffice connection used these values:

- `ONLYOFFICE_APIJS_URL`, usually `http(s)://onlyoffice.<domain>/web-apps/apps/api/documents/api.js`.
- `ONLYOFFICE_INTERNAL_SEAFILE_URL`, usually `http://seafile`, so OnlyOffice server-side downloads/callbacks could use Docker-internal networking.
- `ONLYOFFICE_JWT_SECRET` on Seafile and `JWT_SECRET` on OnlyOffice when JWT was enabled.
- `VERIFY_ONLYOFFICE_CERTIFICATE` and `ONLYOFFICE_FORCE_SAVE`.
- File extension and edit-extension settings written into Seahub.

The fragile parts were not the containers themselves. The fragile parts were hidden coupling and patching:

- Fixed global scripts knew the route names and env-file paths.
- V1 Caddy route generation knew all app hosts up front.
- `vps:doctor` contained explicit Seafile and OnlyOffice validations.
- Seafile's entrypoint edited Python files in the installed Seahub tree to support internal callback/download behavior.
- Suite Manager onboarding described browser editing as already present because the suite assumed both apps could be part of the installed stack.

The useful V1 lesson is that the integration is not a static dependency. It is runtime wiring with generated URLs, a shared secret, Seafile config mutation, health validation, and reapply needs after upgrades or route changes.

## Current V2 Capabilities

V2 already has a strong base for optional integrations:

- Package manifests are discovered from `version-2/apps/<app-id>/manifest.json` and validated before install.
- Packages can declare multiple services, package-owned Dockerfiles, internal ports, volumes, structured routes, Homepage contributions, health checks, setup fields, generated values, and onboarding metadata.
- Seafile core proves multi-service packages with one public service and internal database/cache services.
- Generated and user-supplied secrets are stored as restricted secret files, while SQLite stores only secret references, redacted labels, and fingerprints.
- Public projections keep placeholders such as `${secret.mysqlUserPassword}`; Suite Manager materializes raw secrets only for runtime apply.
- App lifecycle state supports installed, disabled, re-enabled, and uninstalled-with-data-preserved behavior.
- Runtime apply goes through a narrow app agent that accepts bounded multi-service projections, writes package-scoped Caddy route blocks, starts/removes declared services, and checks health.
- Homepage projections are separate from runtime projections and can be applied only after runtime is actually applied.
- Onboarding metadata can describe app-specific next steps without global owner onboarding knowing app details.
- API responses and public package summaries redact secrets.

These capabilities are enough to run another package, but not enough to express "this document editor can serve any compatible file platform" or "this file platform can consume any compatible document editor".

## Missing Capabilities

V2 currently lacks:

- Capability-level dependencies such as "this document editor requires at least one compatible file/content platform to be useful".
- Compatibility metadata so the catalog can explain useful combinations without forcing one package to belong to another package.
- Capability exports, such as OnlyOffice exporting `document-editor.onlyoffice-docs` and Seafile or a future Nextcloud package exporting `document-platform.*`.
- Capability imports, such as Seafile importing a document editor endpoint and JWT secret through a generic `document-editor` integration point.
- Integration-scoped generated secrets owned by the relationship rather than either app alone.
- A policy that says which package may read or receive which exported value.
- Config injection into another installed app's environment, files, or app-local apply hook.
- Integration lifecycle state separate from package install state.
- Reapply behavior after route/domain changes, secret rotation, package upgrade, or config drift.
- Uninstall behavior that removes integration config from every connected package without deleting either package's preserved data.
- UI affordances for "Connect OnlyOffice to Seafile", "Connect OnlyOffice to Nextcloud", "Install a compatible app first", failed integration state, and compatibility disable/uninstall impacts.

## Excluded Models

The desired UX excludes the earlier Seafile-centered options:

- OnlyOffice inside the Seafile package is too narrow. It would make Seafile heavy and would not help a user who chooses Nextcloud or another future file platform.
- OnlyOffice as a Seafile-specific dependency is also too narrow. It incorrectly treats Seafile as the only possible document source.
- Seafile-specific presentation can be useful for the current concrete pair, but it should be a view over generic compatibility metadata, not the underlying architecture.
- Manual-only setup is not good enough. The point of MOS V2 is to avoid raw config and secret handoffs for normal users.
- A separate package named only `seafile-onlyoffice` may be useful internally later, but the user model should not require a unique pair package for every compatible combination unless the pair truly needs custom glue.

## Architecture Direction

Use a generic capability compatibility graph.

Packages should declare:

- Capabilities they provide.
- Capabilities they can consume.
- Whether a capability is useful alone or requires at least one compatible peer.
- Structured compatibility contracts, not only matching strings: capability type, implementation, protocol, interface version, feature flags, and cardinality.
- How values, secrets, URLs, health checks, and config patches flow across an approved relationship.
- Which side owns runtime services and which side owns app-local config mutation.

For Seafile and OnlyOffice:

- OnlyOffice provides a document editor capability.
- Seafile provides a document platform capability and consumes a document editor capability.
- A future Nextcloud package should be able to consume the same OnlyOffice capability through its own integration apply declaration.
- Suite Manager should present compatible pairings based on capability matching, not on hardcoded app ids.

The catalog can still use friendly language. If the user is looking at Seafile, Suite Manager can say "Connect OnlyOffice document editing" once OnlyOffice is installed. If the user is looking at OnlyOffice, Suite Manager can show installed compatible file platforms that are ready to connect and name compatible apps that must be installed separately first.

## Recommended Model

Use capability-driven integration relationships as the core model.

For the motivating case, that means:

- OnlyOffice should be its own package/runtime that provides a `document-editor` capability.
- OnlyOffice should be presented as requiring a compatible file/content platform for a useful normal-user install.
- Seafile should be one compatible consumer, not the parent or owner of OnlyOffice.
- Future file platforms should be able to integrate with the same OnlyOffice package by declaring compatible imports and apply behavior.
- Apps should still install independently through the normal app lifecycle.
- Suite Manager should support one connect flow that wires already-installed compatible apps together when both sides are present.
- Suite Manager core should render generic compatibility and capability metadata. It should not know `ONLYOFFICE_APIJS_URL` or Seafile's Seahub settings.
- The first automatic wiring should be manifest-driven and applied by the existing app package engine plus a narrow privileged app agent extension, not by ad hoc frontend logic.
- Integration relationships should own access grants, desired wiring, applied config digests, validation results, and lifecycle state. Secrets should have explicit scope and cardinality rather than always belonging to the relationship.

This balances low implementation risk with maximum compatibility. It avoids bloating file platforms, avoids pretending OnlyOffice is useful without a file/content source, and creates a reusable path for SSO, SMTP, object storage, backup targets, databases, caches, media helpers, and other many-to-many integrations.

## Proposed Manifest Concepts

These sketches are conceptual, not an implementation commitment.

```json
{
  "id": "onlyoffice",
  "name": "ONLYOFFICE Docs",
  "catalog": {
    "visibility": "compatible-service",
    "installLabel": "Install document editor",
    "needsCapability": {
      "type": "document-platform",
      "reason": "Choose where documents will be created, opened, and saved."
    }
  },
  "exports": {
    "documentEditor": {
      "type": "document-editor",
      "implementation": "onlyoffice-docs",
      "interfaceVersion": 1,
      "protocol": "onlyoffice-docs-api",
      "cardinality": {
        "consumers": "many"
      },
      "features": {
        "browserEditing": true,
        "jwt": true
      },
      "url": "${app.publicUrl}web-apps/apps/api/documents/api.js",
      "healthUrl": "${app.publicUrl}welcome",
      "secrets": {
        "jwt": {
          "scope": "provider-instance",
          "ref": "${secret.jwtSecret}",
          "rotationBlastRadius": "all-consumers"
        }
      }
    }
  },
  "usefulness": {
    "requiresOneOf": ["document-platform"],
    "emptyState": "Install a compatible file app such as Seafile before using OnlyOffice."
  },
  "setup": {
    "fields": [
      {
        "id": "jwtSecret",
        "type": "password",
        "secret": true,
        "generated": { "kind": "random", "bytes": 40, "encoding": "base64url" }
      }
    ]
  }
}
```

```json
{
  "id": "seafile",
  "exports": {
    "filePlatform": {
      "type": "document-platform.seafile",
      "internalBaseUrl": "http://seafile",
      "configTarget": "seahub-settings"
    }
  },
  "integrations": {
    "documentEditor": {
      "accepts": [
        {
          "type": "document-editor",
          "protocol": "onlyoffice-docs-api",
          "interfaceVersion": "^1"
        }
      ],
      "title": "OnlyOffice document editing",
      "providerLabel": "Document editor",
      "cardinality": {
        "providers": "one"
      },
      "apply": {
        "kind": "app-config-patch",
        "target": "seahub-settings",
        "values": {
          "ENABLE_ONLYOFFICE": true,
          "ONLYOFFICE_APIJS_URL": "${import.documentEditor.url}",
          "ONLYOFFICE_JWT_SECRET": "${import.documentEditor.secrets.jwt}",
          "ONLYOFFICE_INTERNAL_SEAFILE_URL": "${export.filePlatform.internalBaseUrl}"
        }
      }
    }
  }
}
```

The config target must be package-owned and allowlisted by the consuming package. For Seafile, a conceptual target might look like:

```json
{
  "configTargets": {
    "seahub-settings": {
      "kind": "settings-file",
      "owner": "seafile",
      "allowedKeys": [
        "ENABLE_ONLYOFFICE",
        "ONLYOFFICE_APIJS_URL",
        "ONLYOFFICE_JWT_SECRET",
        "ONLYOFFICE_INTERNAL_SEAFILE_URL"
      ]
    }
  }
}
```

The integration engine should never patch arbitrary paths, arbitrary env keys, raw Caddy text, or arbitrary shell commands. Suite Manager resolves intent, manifests declare compatible slots and allowed targets, and the app agent applies only package-owned structured targets after validation.

A separate integration package could express the same relationship explicitly:

```json
{
  "id": "seafile-onlyoffice",
  "kind": "integration",
  "dependsOn": [
    { "package": "seafile", "capability": "document-platform.seafile" },
    { "package": "onlyoffice", "capability": "document-editor.onlyoffice-docs" }
  ],
  "display": {
    "consumerPackage": "seafile",
    "actionLabel": "Add OnlyOffice document editing"
  },
  "secrets": {
    "jwt": { "kind": "shared", "source": "onlyoffice.jwtSecret" }
  }
}
```

The pair package should be optional. The preferred default is direct capability matching between installed package manifests. A pair-specific integration package is reserved for cases where the relationship needs substantial extra code that neither side should own.

## Proposed UX

In the global app catalog, OnlyOffice can be visible, but it should be labeled as a document editor that needs a compatible file app. Its primary action should still be the normal package install action. If no compatible document platform is installed, Suite Manager should explain that OnlyOffice can be connected after a compatible file app is installed.

On a compatible file app detail page, Suite Manager should show available document editors. Today that would mean Seafile can show "Connect OnlyOffice document editing." Later, Nextcloud should get the same pattern without Suite Manager adding a Nextcloud-specific branch.

On the OnlyOffice detail page, Suite Manager should show compatible destinations:

- Installed and running file platforms that can be connected now.
- Installed but disabled file platforms that must be enabled before connection.
- Available file platforms that could be installed separately before connection.

When both OnlyOffice and Seafile are installed and running, either detail page can show an action such as "Connect OnlyOffice to Seafile" or "Connect document editing." The flow should show that MOS will generate a shared editing secret, configure Seafile, restart or reapply affected services as needed, and then test the integration.

If integration apply fails, the user should see a distinct integration state, not just "OnlyOffice failed" or "Seafile failed". Advanced details should include sanitized agent steps and health/config diagnostics without raw secrets.

If OnlyOffice is disabled, connected file platforms should remain installed but their document-editing relationships should be disabled or degraded. Suite Manager should say document editing is unavailable until OnlyOffice is re-enabled and the integration is reapplied.

If OnlyOffice is uninstalled with data preserved, Suite Manager should remove or deactivate OnlyOffice settings from every connected file platform while preserving OnlyOffice data/secrets for future recovery.

If a connected file platform is disabled, OnlyOffice may stay installed and remain connected to other file platforms. Only the relationship targeting the disabled platform should become inactive.

## Secret And Security Model

Seafile plus OnlyOffice needs at least one shared secret: the OnlyOffice JWT secret. A future Nextcloud plus OnlyOffice relationship may need a similar or different secret shape. V2 should treat these as integration-scoped grants rather than arbitrary cross-app secret reading.

The main refinement is that "integration secret" is too broad. Secrets need explicit scope and cardinality:

- `provider-instance`: one secret owned by the provider app instance. Relationships receive grants to consume it. Rotating it affects every active consumer.
- `consumer-instance`: one secret owned by the consumer app instance. This is useful when a provider needs a credential generated by the consumer.
- `relationship`: one secret per relationship. Rotating it affects only that relationship, but only works if the provider supports per-consumer credentials.
- `generated-client`: a client credential created for a specific consumer, common for SSO/OIDC-style integrations.

OnlyOffice appears to fit `provider-instance` scope because the Docker Document Server exposes one global `JWT_SECRET`. A relationship can still control authorization through a grant, but rotating or revoking the provider secret may require reapplying every connected file platform. MOS should model that blast radius honestly instead of pretending each relationship can always have an independent JWT secret.

Recommended rules:

- Raw secrets remain in the secret backend and are never returned in package summaries, logs, operation records, diagnostics, or public projections.
- A package may export a secret only through an explicitly declared capability field.
- A consumer may import a secret only if its manifest declares the compatible capability and the integration relationship is active.
- Suite Manager may materialize raw integration secrets only inside an apply request to the privileged agent or app-local hook that needs them.
- SQLite stores references, fingerprints, redacted labels, source metadata, secret scope, grant ids, and relationship ids.
- Rotation should create a new secret version, compute the affected relationships from the secret scope, reapply affected packages, and mark relationships degraded if either side cannot accept the new value.
- Failed applies should not leave raw secret values in generated config previews.
- Deleting an integration should revoke future access to the exported secret, even if both packages remain installed.

The long-term secret store may evolve beyond restricted files, but the policy should be designed now so the current file-backed mechanism can be replaced without changing package manifests.

## Lifecycle Model

The happy path should be:

1. Install packages independently through the normal app lifecycle.
2. Select a compatible installed provider and consumer, such as OnlyOffice plus Seafile.
3. Create an integration relationship record.
4. Generate or bind integration secrets.
5. Render updated projections for both packages or for the integration.
6. Apply runtime changes through the app agent.
7. Restart/reload affected services if required.
8. Run package health checks and integration-specific validation.
9. Mark the integration applied with digests of the consumed exports and applied config.

Relationship state should be explicit and separate from package state:

- `available`: compatible installed packages exist, but no relationship exists.
- `planned`: the owner selected provider and consumer, but no apply has started.
- `applying`: Suite Manager or the agent is rendering/applying the relationship.
- `active`: the relationship is applied and validation passed.
- `degraded`: the relationship exists, but provider/consumer disabled, health failed, an export changed, a secret grant changed, or reapply is needed.
- `disabled`: the relationship is intentionally inactive while data/secrets are preserved.
- `removing`: cleanup or deactivation is being applied.
- `removed`: the relationship is no longer active, though recoverable history may remain.
- `failed`: the last operation failed. The previous applied state may or may not still be active.

Relationship state should store at least:

- `relationship_id`
- `provider_instance_id`
- `consumer_instance_id`
- `provider_capability_id`
- `consumer_integration_slot`
- `desired_projection_digest`
- `last_applied_projection_digest`
- `consumed_export_digest`
- `secret_grant_ids`
- `last_validation_result`
- `last_error_code`
- `created_at`
- `updated_at`

Disable should remove runtime exposure where appropriate and mark the integration inactive without deleting data or secrets.

Uninstall-preserve-data for the document editor should remove or deactivate integration config from all connected file platforms, stop/remove editor services, preserve editor volumes/secrets, and keep recoverable relationship history.

Uninstall-preserve-data for a file platform should keep the document editor runtime state but deactivate relationships that target that file platform.

Upgrade and route/domain changes should trigger integration reapply when consumed exports change. For Seafile and OnlyOffice, a changed OnlyOffice public URL or JWT secret must re-render Seafile settings. For other file platforms, the same export change should trigger their package-declared integration projection.

Config drift should be detected by comparing desired integration projection digests with last-applied digests, not by treating live containers as source of truth.

## Generalization Beyond Seafile And OnlyOffice

The model should later support:

- App plus database: an app imports a database capability without reading unrelated database secrets.
- App plus Redis/cache: an app imports a cache endpoint and optional auth secret.
- App plus SSO provider: an app imports issuer URL, client id, and client secret from an identity package.
- App plus SMTP provider: compatible apps import SMTP host/port/security and a scoped credential.
- App plus object storage: apps import bucket endpoint, bucket name, access key, and secret key.
- App plus backup target: installed apps export backup scopes and import target capabilities.
- App plus document editor: Seafile, Nextcloud, or another file platform imports OnlyOffice, Collabora, or another compatible editor capability.
- App plus photo/media helper: a photo app imports a machine-learning worker, transcoder, or face-recognition helper.

V2 should not build all of this now. It should make the first metadata and state model broad enough that these examples do not require a second redesign.

## Validation Cases

Before real OnlyOffice wiring, use fixture packages to test:

- Provider installed first, consumer installed later.
- Consumer installed first, provider installed later.
- Provider disabled while a relationship is active.
- Consumer disabled while a relationship is active.
- Provider uninstalled with data preserved.
- Consumer uninstalled with data preserved.
- Export changes because route/domain changes.
- Export changes because a scoped secret rotates.
- Relationship apply fails after provider projection succeeds but before consumer projection succeeds.
- Secret file missing or unreadable.
- Secret grant exists but relationship is not active.
- Two consumers connect to one provider when the provider allows many consumers.
- One consumer attempts to connect to two providers when the slot allows only one provider.
- Capability type matches but protocol or interface version does not.
- Suite Manager renders compatibility without hardcoded Seafile or OnlyOffice strings.

## First Implementation Slice Recommendation

Do not implement OnlyOffice in the first slice after this research.

The smallest useful next slice is capability metadata and compatibility UI shape:

- Add manifest validation for `exports`, `integrations`, `usefulness.requiresOneOf`, capability type/interface/protocol/version, feature flags, cardinality, secret scope, and package-owned config targets using a small fixture package pair.
- Teach the Apps UI to show compatibility: providers, consumers, missing compatible peers, and connect actions only when both compatible apps are installed.
- Add tests proving Suite Manager renders capability compatibility generically and does not special-case Seafile/OnlyOffice.
- Keep automatic Seafile config wiring out of the first slice.

Recommended sequence:

1. Validate Seafile core in Hyper-V first so multi-service packages are operationally proven before layering integrations on top.
2. Add capability metadata validation with fake fixture packages only.
3. Add compatibility UI only: installed compatible apps, missing compatible apps, disabled compatible apps, useful/not-useful-alone messaging, and enabled/disabled connect actions.
4. Add relationship state and dry-run projection rendering with fixture packages.
5. Add narrow config-target apply for package-owned allowlisted targets, still with fixtures.
6. Add the real OnlyOffice provider package, honestly labeled as useful only when connected to a compatible file/content app.
7. Add the real Seafile-to-OnlyOffice connection after the generic relationship path is tested.

## Open Questions

- Should V2 expose capability providers like OnlyOffice in the global catalog? Recommended answer: yes, but the card should say what compatible peer is needed before it becomes useful.
- Should capability providers be installable without a compatible consumer? Recommended answer: yes, but as a normal independent package install with clear usefulness guidance. The integration action appears only after a compatible consumer is also installed.
- Should integration state be stored as a separate table? Recommended answer: yes, because package install state and relationship state have different lifecycles.
- Should a relationship be represented by a hidden integration package? Recommended answer: not by default. Use manifest-declared capability matching first; reserve integration packages for complex glue that cannot live cleanly in either app package.
- Should Seafile config mutation be an app-local hook or a generic config patch projection? Recommended answer: start with a generic declared config patch that the app agent applies through a narrow package-owned target; allow app-local hooks later for version-sensitive migrations.
- Should raw exported secrets ever be available to another package's normal runtime env? Recommended answer: only through an active relationship apply, not as broad persistent cross-app read access.
- Should OnlyOffice JWT be generated by OnlyOffice or by the relationship? Recommended answer: model it as a provider-instance secret with relationship grants unless OnlyOffice proves it can safely support per-consumer credentials. Rotation must disclose and handle the all-consumers blast radius.

## Final Recommendation

OnlyOffice should be its own V2 package that provides a document-editor capability, not part of the Seafile core package and not tied only to Seafile.

Normal users should encounter it as a compatible document editor that must be connected to a file/content platform. Apps should install independently first. Once both sides are installed, Seafile can show "Connect OnlyOffice document editing" and OnlyOffice can show installed compatible file platforms that are ready to connect.

App-to-app wiring should be manifest-driven through generic capability exports/imports and an explicit integration lifecycle record. Suite Manager core should know how to render compatibility, resolve compatible capabilities, enforce secret policy, and ask the app agent to apply projections; it should not hardcode Seafile's OnlyOffice settings.

The generic engine support needed is structured capability metadata, compatibility matching, scoped secret grants, integration state, reapply/rotation behavior, and a narrow agent path for package-owned allowlisted config injection.

Postpone the real OnlyOffice package, automatic Seafile wiring, destructive uninstall semantics, advanced pair-specific integration packages, and manual operator escape hatches until the metadata/UI and integration-state slices are proven.
