# MOS App Packages

MOS app packages live here, one app per folder.

Each app package should own its app-specific manifest, Dockerfiles, setup helpers, runtime assets, optional Homepage contributions, backup metadata, and technical notes.

## The manifest contract

`manifest.json` follows the locked, versioned manifest contract (generation 1, `manifestVersion: 1`):

- `manifest.schema.json` in this folder is the canonical machine-readable JSON Schema. The backend validator interprets this exact file; do not hand-edit validation logic into divergence with it.
- The authoring reference for humans and agents is the public site page `site/src/content/docs/docs/reference/manifest.md` (published at `/docs/reference/manifest/`), covering every supported field, the template grammar, semantic rules, and the provisional areas outside the lock.
- `npm run apps:manifest:check` validates every package (structure + semantics) without running MOS.
- Unknown manifest fields are ignored, never fatal, and never projected into runtimes. Amendments to the contract must be optional additive fields; changing an existing field's meaning requires a new manifest generation. See the amendment policy in `AGENTS.md` and `docs/decisions.md`.

## Package identity and sources

MOS platform versions, MOS app-package versions, and upstream component versions are separate identities. Updating an app package does not require publishing a MOS platform release unless the candidate requires a newer platform contract.

The repository holds the latest available official package for each app. On install or update, a MOS instance preserves a self-contained installed package snapshot: its manifest and setup schema, privacy review, runtime assets, package/source identity, and exact component artifacts. Settings and lifecycle actions use that installed snapshot. A periodically fetched candidate package is used only for update comparison until it applies successfully. A rollback-safe transaction may retain one prior local snapshot for interrupted-operation recovery and forensic support. MOS does not currently offer an owner-triggered rollback to that snapshot, and it is not a promise that data migrations can be reversed.

Every installed package records its source repository, path, immutable source revision, package digest, package version, minimum compatible MOS platform version, and trust level. Official packages are `mos-reviewed`; owner-added Git sources are `unverified`. `publisher-signed` is reserved for a future publisher-key verification design and is refused today. `local` source records are a development-only storage seam and are not accepted by the end-to-end source URL flow. Structural validity never promotes external content to reviewed trust.

## MOS Privacy Posture

Each reviewed candidate package owns a `privacy-review.json` and a compact manifest summary. Reviews are validated by `npm run apps:privacy:check` against the contracts in `suite-manager/backend/src/apps/package-contracts.cjs`, which enforce the document's shape, its binding to the package it ships with, and the derivation of its posture. The assessment binds to the package version, digest, immutable source revision, component versions, and artifact digests. It travels into the installed package snapshot, so an owner sees the review for the package actually running rather than the latest repository wording. The assessment records provenance, including the AI model only when runtime-reported and whether a human reviewed it. It is not a legal audit or guarantee.

The posture is derived from exactly two dimensions, and both are questions of fact rather than judgement. `defaultEgress` is settled by a runtime capture: installed as MOS ships it and used normally, does anything leave the owner's server? `control` is settled by reading the package and the app's own settings: who decided that, and can the owner change it? The line between `left-to-owner` and `accepted-by-mos` is whether the app offers a control the owner can actually reach — an in-app setting is the owner's decision to make, while a value reachable only by editing packaging MOS owns is MOS's decision and is recorded as MOS's.

The four legal combinations map one-to-one onto the four postures:

| `defaultEgress` | `control` | posture |
| --- | --- | --- |
| `none` | `nothing-to-decide` | `private-by-default` — the app has no external touchpoint to begin with. |
| `none` | `disabled-by-mos` | `privacy-configured` — it had one, and MOS switched it off so the owner never has to. |
| `external-contact` | `left-to-owner` | `owner-disableable` — something leaves, the app has a setting that stops it, and MOS judged the trade-off genuinely the owner's to make. |
| `external-contact` | `accepted-by-mos` | `external-dependency` — something leaves, no in-app setting stops it, and MOS reviewed and accepted it as the price of the feature. |

Any other pairing is a contradiction and fails validation instead of resolving into a badge. The derivation has no fallthrough, so it cannot publish a verdict nobody chose.

The remaining dimensions — `accountDependency`, `dataProcessing`, `policyExposure`, `confidence` — describe the app and feed the published grade, but do not steer the posture. That separation is deliberate: no reviewer should ever have to bend a descriptive fact to reach a defensible badge.

No dimension may be `unknown`. An unestablished fact is not a posture — it means no review exists, which the catalog records as `privacy.status: review-required`, a process state that never reaches this derivation. A posture describes a finished review and nothing else.

Evidence is labeled `observed`, `configured`, `documented`, or `inferred`; configuration alone must not be presented as proof of network silence, so `defaultEgress: none` is only credible with an `observed` capture behind it. App updates and detected Terms, privacy-policy, ownership, telemetry, or outbound-dependency changes trigger reassessment.

Use `icon.png` in the package root for the catalog icon, and point `manifest.json` `icon` at that file. Richer screenshots, marketing assets, and `catalog.demoDeployTargets` are optional catalog metadata, not required package scaffolding. Demo deployment targets are public-site previews on third-party providers; they are not MOS installation instructions.

The first package is `stirling-pdf`, intentionally chosen as a boring app to prove discovery, manifest validation, projections, and lifecycle behavior before MOS grows a catalog.

The second package is `vaultwarden`, intentionally chosen to pressure-test generated setup values, secret redaction, persistent storage, package onboarding metadata, and app-specific runtime environment projection without adding app-specific logic to Suite Manager core.

The third package is `radicale`, validating calendar/contact sync against the current package model. It uses generic package setup fields for user-supplied credentials, one persistent data volume, one app route with a structured tokenized iCal bridge, and one Homepage tile with a calendar widget.

The fourth package is `seafile`, the first substantial multi-service package in MOS. It uses package-owned Seafile, MySQL, and Valkey services, generated internal database/JWT secrets, user-supplied initial Seafile admin credentials, one public app route, internal-only dependency services, and persistent Seafile/MySQL volumes.

The fifth package is `onlyoffice`, intentionally chosen as the first capability provider package. It installs independently, exports a document-editor capability, has no normal Homepage shortcut, and becomes useful after a compatible document platform such as Seafile is installed and connected through the app integration flow.

Package manifests describe install inputs and projections only. An app becomes active only after Suite Manager persists app instance state and the app lifecycle agent applies the generated runtime projection. Stop removes the active containers without deleting package config, secret references, Docker volumes, routes, or Homepage shortcuts. Uninstall removes the active runtime, route, MOS-owned Homepage shortcut, package Docker volumes, package config, secret references, and integration rows so the app returns to a clean installable state.

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

Packages may set a `role` such as `capability-provider` when they are useful mainly through other apps. Suite Manager groups those packages as companion apps, suppresses Homepage shortcut controls when no `homepage` contribution is declared, and keeps integration relationships truthful across restart, stop, start, and uninstall lifecycle actions.
