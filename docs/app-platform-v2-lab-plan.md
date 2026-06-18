# App Platform V2 Lab Plan

This is a temporary branch plan for the clean V2 lab. Before this branch merges, convert active work into GitHub Issues and keep only durable decisions in `docs/decisions.md`.

## Goal

Prove the next MOS architecture from a clean starting point in `version-2/`: install the control plane first, create the MOS owner in Suite Manager on first browser visit, then add optional apps later through package-owned flows.

This branch starts with Suite Manager only. Do not migrate optional app catalog behavior until the install, testing, and first-run owner flow are trustworthy.

## Starting Rules

- Base work on `staging`.
- Treat the existing repo implementation and `feat/app-catalog-provisioning` as reference material, not the V2 runtime.
- Do not copy the whole prototype branch into the repo.
- Keep new V2 code isolated under `version-2/` until a slice is proven.
- Reuse the existing Suite Manager design framework and shared components by deliberately copying or rebuilding the needed primitives into `version-2/`, not by importing from the old app at runtime.
- Reuse the DigitalOcean smoke harness for real install validation, but do not run paid smoke commands automatically.
- Do not add optional apps during the first milestone.

## Product Slice 1

The first testable slice is:

1. Cloud or USB installer boots the MOS control plane.
2. Installer does not require owner email or owner password.
3. Suite Manager first visit shows a first-run owner creation screen.
4. Owner submits name, email, and password in the browser.
5. Suite Manager persists owner identity and password hash in its state.
6. Suite Manager signs the owner in and lands on the control-plane dashboard.
7. A fresh DigitalOcean smoke install can validate readiness and owner creation without SSH-only manual repair.

## Current Lab Scaffold

- `version-2/README.md` explains the clean-slate workspace.
- `version-2/src/platform-contract.cjs` captures the first contract in executable form.
- `version-2/test/platform-contract.test.cjs` validates the contract.
- `npm --prefix version-2 test` runs the V2 tests without touching the existing stack.

## Existing Code To Reuse Later

- Suite Manager shared primitives in `apps/suite-manager/frontend/src/components/ui.tsx`.
- Suite Manager auth/session patterns in `apps/suite-manager/src/features/auth` and `apps/suite-manager/frontend/src/features/auth`.
- Host-agent capability detection patterns in `apps/suite-manager/src/features/service-agent`.
- DigitalOcean smoke harness in `scripts/smoke/digitalocean.cjs`.
- Prototype learnings from `feat/app-catalog-provisioning`, especially package-owned projections and avoiding Suite Manager restarts mid-request.

## Explicit Non-Goals For Slice 1

- No optional app catalog UI.
- No app package migration.
- No app-specific setup helpers.
- No uninstall, backup-per-app, or selected-app update behavior.
- No migration logic for old all-app development installs.

## Validation Gates

- Unit-level lab contract passes with `npm --prefix version-2 test`.
- Existing Suite Manager tests still pass after implementation changes.
- Installer scripts can render without owner credentials.
- DigitalOcean smoke can run against the branch with a browser-created owner account.
- E2E owner creation should be added before this becomes a merge candidate, but agents should ask the user to run E2E commands.

## Next Implementation Steps

1. Add a first-run setup state model to Suite Manager that distinguishes `needs-owner` from signed-out and signed-in states.
2. Add backend endpoints for owner creation with password hashing, duplicate-owner protection, and session creation.
3. Add a first-run UI using shared Suite Manager components.
4. Update installer env templates so owner credentials are optional for fresh V2 control-plane installs.
5. Adapt the DigitalOcean smoke harness so it can validate the no-owner installer path and report the first-run URL.
