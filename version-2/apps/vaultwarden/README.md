# Vaultwarden V2 Package

This package is the second V2 app package and exists to pressure-test generic package setup, generated secrets, persistence, routes, and onboarding metadata.

## Runtime Shape

- Primary service: `vaultwarden`
- Dockerfile: `Dockerfile`
- Internal HTTP port: `80`
- Public route host: `vaultwarden.<mos-base-domain>`
- Health endpoint: `/alive`

## Persistence

The package declares one persistent mount:

- `/data`

The first V2 Vaultwarden package uses Vaultwarden's built-in SQLite storage to stay inside the current one-service lifecycle slice. A future richer package can introduce PostgreSQL once package dependencies and companion services are generic.

## Setup

The package declares a generated secret setup field:

- `adminToken`: generated at logical install time, stored as a restricted secret file, and represented in SQLite by secret reference, redacted label, and fingerprint only.

Runtime environment values are projected generically from manifest fields:

- `ADMIN_TOKEN=${secret.adminToken}`
- `DOMAIN=${app.publicUrl}`
- `SIGNUPS_ALLOWED=true`
- `WEBSOCKET_ENABLED=true`

Suite Manager must not return the raw admin token in package listings, install responses, logs, or projection previews.

## Secret Management Caveat

The current file-backed secret storage is a V2 package-contract proving step, not the final MOS secret management system. Vaultwarden needs a recoverable admin token so the runtime can be reapplied, restarted, or updated with the same value, but this first slice only separates raw secret material from broad SQLite state and public APIs.

After Vaultwarden is verified to install and run in Hyper-V, the next package-platform task should harden this into an explicit secret-management subsystem before adding more secret-bearing app packages. That follow-up should cover encrypted-at-rest storage or a local secret-store agent, rotation/reveal rules, backup/restore behavior, permission ownership, missing-secret recovery, and expanded redaction tests.
