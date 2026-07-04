# V2 App Packages

Future app packages live here, one app per folder.

Each app package should own its app-specific manifest, Dockerfiles, setup helpers, runtime assets, Caddy snippets, Homepage contributions, backup metadata, and technical notes.

Use `icon.png` in the package root for the catalog icon, and point `manifest.json` `icon` at that file. Richer screenshots or marketing assets are optional catalog metadata, not required package scaffolding.

The first package is `stirling-pdf`, intentionally chosen as a boring app to prove discovery, manifest validation, projections, and lifecycle behavior before MOS grows a catalog.

The second package is `vaultwarden`, intentionally chosen to pressure-test generated setup values, secret redaction, persistent storage, package onboarding metadata, and app-specific runtime environment projection without adding app-specific logic to Suite Manager core.

The third package is `radicale`, intentionally chosen to validate a V1-era calendar/contact sync app against the V2 package model. It uses generic package setup fields for user-supplied credentials, one persistent data volume, one app route with a structured tokenized iCal bridge, one Homepage tile with a calendar widget, and the same lifecycle preserve-data semantics as the earlier packages.

The fourth package is `seafile`, intentionally chosen as the first serious multi-service V1-era pillar app in V2. It uses package-owned Seafile, MySQL, and Valkey services, generated internal database/JWT secrets, user-supplied initial Seafile admin credentials, one public app route, internal-only dependency services, and preserved Seafile/MySQL volumes.

The fifth package is `onlyoffice`, intentionally chosen as the first capability provider package. It installs independently, exports a document-editor capability, and becomes useful after a compatible document platform such as Seafile is installed and connected through the app integration flow.

Package manifests describe install inputs and projections only. An app becomes active only after Suite Manager persists app instance state and the app lifecycle agent applies the generated runtime projection. Disable and preserved-data uninstall remove the active runtime and route without deleting package config, secret references, or Docker volumes.

## Post-install setup guides

Packages may declare lightweight post-install guidance in `manifest.json` under `onboarding`. This is for apps that run successfully after install but still need owner action in another client, device, or app-native setup flow.

Use setup guides for contextual help such as:

- app URL and non-secret connection details;
- copyable non-secret config values;
- warnings and notes;
- ordered instructions;
- device or client choices with one selected guide at a time;
- manual completion or skip actions.

Do not use setup guides for:

- arbitrary JavaScript or app-specific React components;
- shell commands or host mutations;
- app database queries or polling;
- cross-app credential collection;
- raw secret reveal or copy actions.

Guide values may interpolate `${app.publicUrl}` and non-secret `${config.fieldId}` values. They must not interpolate `${secret.fieldId}` values. For secret fields, write explanatory text instead, such as "Use the password you entered during install."

Suite Manager persists guide state per app instance in SQLite. The first guide slice tracks only viewed, completed, and skipped state for the whole guide; per-section progress is future contract work.

## App integrations

Packages may declare capability exports, integration slots, usefulness hints, and package-owned config targets in `manifest.json`.

The first real relationship is Seafile consuming ONLYOFFICE as an office editor. Suite Manager resolves the compatible manifests, grants Seafile the provider-instance ONLYOFFICE JWT secret only for the apply operation, patches Seafile's allowlisted service environment projection, attaches ONLYOFFICE to Seafile's package network for server-to-server document traffic, reapplies Seafile through the app agent, and records relationship state in SQLite.
