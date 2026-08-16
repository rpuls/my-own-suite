---
title: The manifest contract
description: The locked generation-1 reference for apps/<app>/manifest.json — every supported field, the template grammar, the open-world rule, and how to validate a package without running MOS.
---

`manifest.json` is the one contract in My Own Suite that is a promise to people outside the project: package authors. This page is the authoritative reference for **manifest generation 1** — the first locked generation. It is written for both humans and AI agents authoring packages.

The promise, concretely:

1. **Every field documented here is supported by every MOS release that supports generation 1.** A valid generation-1 manifest will not be rejected by a future MOS release.
2. **Unknown fields are ignored, never fatal.** A manifest may carry fields this page does not describe; MOS validates what it knows, ignores the rest, and never projects an unknown field into a runtime. This is the amendment mechanism: future capabilities arrive as *optional* additions, and a package that uses one declares the `minimumMosVersion` that introduced it.
3. **Nothing beyond the required core is ever mandatory.** UI renders an absent optional field as absent, not as an error.
4. **Amendments are additive and rare.** Changing the meaning of an existing field requires a new generation (`manifestVersion: 2`), which is an event, not maintenance.

Two artifacts define the contract:

- **[`apps/manifest.schema.json`](https://github.com/rpuls/my-own-suite/blob/main/apps/manifest.schema.json)** — the machine-readable JSON Schema (draft 2020-12). Validate against it with any standard JSON Schema tool. MOS itself interprets this exact file; there is no second hand-written validator to drift from it.
- **The semantic rules** on this page — cross-references and the template grammar, which JSON Schema cannot express. In a repository checkout, `npm run apps:manifest:check` runs both passes over every package (or over folders you name) without running MOS.

## A complete minimal manifest

```json
{
  "manifestVersion": 1,
  "id": "example-app",
  "name": "Example App",
  "version": "0.1.0",
  "minimumMosVersion": "0.17.0",
  "summary": "One plain-language line about what the app does.",
  "category": "tools",
  "icon": "icon.png",
  "resources": {
    "services": {
      "example-app": {
        "dockerfile": "Dockerfile",
        "internalPort": 8080,
        "env": { "PUBLIC_URL": "${app.publicUrl}" },
        "volumes": ["data:/data"]
      }
    }
  },
  "routes": [{ "host": "example-app", "service": "example-app" }],
  "health": { "type": "http", "url": "http://example-app:8080/healthz" }
}
```

That is a working package once the folder also contains the pinned `Dockerfile`, an `icon.png`, and (for the official catalog) a `privacy-review.json`.

## Required fields

| Field | Meaning |
| --- | --- |
| `manifestVersion` | Always `1`. Declares the generation this manifest targets, so a MOS release that does not know it refuses the package instead of misreading it. |
| `id` | DNS-safe lowercase package id (`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`), stable for the life of the package. Names the folder, namespaces containers and volumes. |
| `name` | Human-readable app name. |
| `version` | The **package** version (semver). Independent of both the MOS platform version and the upstream app version. Any content change requires a bump — installed machines are offered updates purely by comparing this value. |
| `minimumMosVersion` | Oldest MOS release the package works on. Raise it when you use a field or template namespace introduced later. |
| `summary` | One-line catalog-card description. |
| `category` | Free text. Reuse an existing category when one fits (`media`, `storage`, `office`, `security`, `tools`); an unknown category renders as written with default styling. |
| `resources.services` | At least one service — see below. |
| `health` | How MOS decides the app is up — see below. |

## Services (`resources.services`)

Each key is a DNS-safe service id, which is also the container's hostname on the package-private network.

| Field | Required | Meaning |
| --- | --- | --- |
| `dockerfile` | yes | Package-root Dockerfile: `Dockerfile` for the primary service, `Dockerfile.<service>` for others. Base images must be pinned by immutable digest (`FROM image@sha256:…`) — floating tags are refused at review. |
| `internalPort` | yes | The one TCP port the service listens on. |
| `env` | no | Environment map: `UPPER_CASE` keys, string values, template references allowed (see the grammar below). |
| `volumes` | no | Persistent storage as `<volume-name>:<absolute-container-path>`. **Named volumes only** — host paths, bind mounts, and device paths are refused by design (they break backup, restore, and isolation). Volume names are unique within the package; each volume belongs to exactly one service. |
| `requires` | no | What the service needs to run well — see below. |

MOS does not order service startup. A service must tolerate its dependencies starting later and retry — every mainstream server image already does.

### Resource requirements (`requires`)

Added in MOS 0.18.0. Optional, display-only, and advisory: MOS applies no cgroup limits from these figures. They exist so an owner can be told whether another app still fits on the server.

```json
"requires": { "cpuCores": 0.25, "memoryMb": 1024, "cpuPeakCores": 2, "memoryPeakMb": 2048 }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `cpuCores` | yes | Cores the service occupies in normal use. Fractional allowed. |
| `memoryMb` | yes | RAM the service holds **at rest**. |
| `cpuPeakCores` | no | Cores it wants available during heavy work (OCR, transcoding, indexing). |
| `memoryPeakMb` | no | RAM it needs available during heavy work. |

Two rules make the arithmetic honest, so state the figures accordingly:

- **Resting figures add up; peak figures do not.** A resting figure is a running cost every installed app pays at once. A peak is headroom that only has to be free while that app is busy, so MOS keeps the largest peak rather than the sum. Within one package the services can be busy together, so a package's own peaks are summed into its total.
- **Describe the container, not the project's recommended server.** Upstream "minimum 2 GB RAM" usually means the machine, and often means the peak. `memoryMb` is what the container actually occupies idle.

Declare `requires` on every service of a package or none: a package with figures on only some of its services shows no total, because a partial sum understates it. A peak below its resting figure is rejected.

## Routes

```json
"routes": [{ "host": "example-app", "service": "example-app" }]
```

Each route publishes one HTTPS hostname (`<host>.<suite-domain>`), terminated by MOS and reverse-proxied to the service's `internalPort`. Routes are structured data — raw proxy configuration is refused. Generation 1 routes are HTTP(S) only; a future contract for other protocols would arrive as a separate optional field, not a reinterpretation of `routes`.

## Health

```json
"health": { "type": "http", "url": "http://example-app:8080/healthz" }
```

`type` is `http` in generation 1. The URL's hostname **must be a declared service id** — the probe runs on the package network. Future probe types (`tcp`, …) arrive as new `type` values gated by `minimumMosVersion`.

## Setup fields (`setup.fields`)

The install form, as data. Each field:

| Field | Meaning |
| --- | --- |
| `id` | camelCase id, referenced as `${config.<id>}` (non-secret) or `${secret.<id>}` (secret). |
| `type` | `text`, `email`, `password`, `url`, or `boolean`. Values are stored as strings; boolean stores `"true"` / `"false"`. |
| `label` | What the owner sees. |
| `required` | Optional boolean. |
| `secret` | Secret values are stored as redacted references and materialized only for runtime apply. A secret field must not declare a `default`. |
| `redactedLabel` | Label shown in place of a secret's value. |
| `default` | Prefill for non-secret fields. The **only** place `${owner.name}` / `${owner.email}` may appear. |
| `generated` | `{ "kind": "random", "bytes": 16–128, "encoding": "base64url" \| "hex" }` — MOS generates the value at install; the owner is never prompted. |

## Catalog metadata (`catalog`)

All display-only. `description` (the fuller paragraph for the app detail view — the one-line `summary` is what catalog rows show, and neither substitutes for the other), `tags`, `related` (app ids), `features` (`{title, body?}`), `resourceHint` (`level`: `low`/`medium`/`high` + `label`/`description` — the plain-language band, shown alongside the exact figures in `resources.services.<id>.requires`), `privacy` (`summary`, `notes[]` — the plain-language summary; the bound `privacy-review.json` is the authoritative assessment), `links` (`website`/`docs`/`repository`; other keys ignored), `demoDeployTargets` (public-site deploy links), and:

- **`replaces`** — an array of product names, one per entry, ranked most-recognised first: `["Google Photos", "iCloud Photos", "Amazon Photos", "Flickr"]`. List every commercial product the app genuinely stands in for, not only the obvious two — search matches each entry, and the app's page on this site lists all of them. Space-constrained surfaces (catalog cards, the Suite Manager detail hero) name only the first two, which is why the ranking matters.
- **`screenshots`** — `{src, alt?, caption?}` where `src` is a package-relative path listed in `packageFiles`. Remote screenshot URLs are refused: browsing the catalog must never fetch third-party origins.

## Homepage tile (`homepage`)

`group` and `icon` are required when the block is present; `name` defaults to the package name and `description` to the summary. Omit the block for packages that should not appear on the dashboard (capability providers usually do).

## Onboarding guide (`onboarding`)

Declarative post-install guidance rendered by Suite Manager: `title`, `summary`, and `sections[]`, each `{id, type, title, body?, …}` with `type` one of `note`, `warning`, `steps` (with `steps: [string]`), `values` (copyable `{label, value, copy?}` entries), `choice-guide` (per-device `choices[]`, each with its own `steps`), `manual-complete` (with `actionLabel`).

Guides are data, never behavior: no scripts, no app-specific components, no host mutations. `values[].value` may interpolate `${app.publicUrl}` and non-secret `${config.*}`; secrets never appear in a guide — write "use the password you chose during install" instead.

## Update expectations (`update`)

What updating **to** this package version means for an installed machine: `backupRequired`, `breakingChanges` (declared structural areas — an undeclared structural change makes the update unofferable), `downtime` (`none`/`brief`/`extended`/`unknown`), `migrations[]`, `ownerActions[]`, `minimumAppAgentVersion`, `rollback` (`safe`/`not-guaranteed`/`unsupported`).

## Other top-level fields

- `architectures` — `["amd64"]` and/or `["arm64"]`. Omitted means unconstrained; incompatible hosts refuse the install before building.
- `packageFiles` — every extra file the package ships beyond the fixed root set (`manifest.json`, `Dockerfile*`, `README.md`, `entrypoint.sh`, `icon.*`, `privacy-review.json`). Undeclared files do not survive packaging.
- `icon` — package-relative icon path, conventionally `icon.png`.

## The template grammar

Manifest strings may reference values MOS resolves at install or runtime:

```
${namespace.path}
```

A reference is recognized only when the namespace is a lowercase word followed by a dot. Anything else — `${UPPER_CASE}`, `${no-dot}`, `$plain` — is literal text and passes through untouched, so shell-style `${VAR}` syntax in env values keeps working.

| Namespace | Resolves to | Allowed in |
| --- | --- | --- |
| `${config.<fieldId>}` | A non-secret setup field's value | Service env, onboarding `values[].value`, provisional areas |
| `${secret.<fieldId>}` | A secret setup field's value | Service env and provisional areas only — never onboarding, never catalog |
| `${app.host}` / `${app.scheme}` / `${app.publicUrl}` | The app's public hostname, scheme, and full URL | Service env, onboarding `values[].value`, provisional areas |
| `${owner.name}` / `${owner.email}` | The suite owner's profile | `setup.fields[].default` only |
| `${import.*}` / `${export.*}` | Capability wiring | The provisional capability system only |

**Every reference is validated.** A typo like `${config.adminUserName}` fails validation instead of shipping verbatim into a container env var and failing silently on someone else's machine. An unknown namespace is an error too — future namespaces (an SMTP relay would introduce `${smtp.*}`) are reserved and arrive gated by `minimumMosVersion`.

## Provisional areas — outside the lock

These work today for official packages but their shape is **not** frozen; avoid them in external packages unless you accept migration later:

- `role` (`capability-provider`), `exports`, `integrations`, `configTargets`, `usefulness` — the capability system. Proven by exactly one relationship (Seafile ⇄ ONLYOFFICE); it will be locked when more relationships have shaped it.
- `homepage.widget` — only the monthly calendar widget exists; a general widget contract is future work.
- `routes[].internalIcalBridge` — a token-gated read-only proxy path, expected to be replaced by a general bridge contract.

## What stays out — permanently

These are refused by design, not omissions to work around: host paths and bind mounts, cross-package shared volumes, host networking, device passthrough, privileged containers, the Docker socket, raw Caddy/proxy directives, arbitrary scripts in guides, and OIDC/LDAP/SSO wiring (MOS is deliberately single-owner). If your app cannot be expressed without one of these, that is a platform conversation — open an issue rather than bending the package.

## Validating a package

```bash
# both passes (structure + semantics), no running MOS required:
npm run apps:manifest:check                # every apps/<app>/
npm run apps:manifest:check -- path/to/pkg # specific folder(s)
```

Or validate structure alone against `apps/manifest.schema.json` with any JSON Schema validator. Semantic rules the schema cannot express (and the checker enforces): template references resolve against declared fields and namespaces; `routes[].service` and the `health` hostname name declared services; declared package files exist; screenshots are declared in `packageFiles`; secret fields carry no defaults; volume names are unique per package.

## Amendment policy

Recorded in the repository's decision log and agent rules: a manifest change must be an **optional, additive** field; the UI must render its absence as absence; a change to an existing field's meaning requires a new generation; and reintroducing a closed allow-list anywhere in the manifest shape is a regression (a unit test fails if anyone tries).
