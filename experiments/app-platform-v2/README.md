# App Platform V2 Lab

This folder is an isolated lab for the Suite Manager-first V2 platform. It is intentionally separate from the current runtime until the first slice is proven.

## First Slice

Build and validate the control plane before optional apps:

- Install Suite Manager, Homepage, Caddy, and required host agents.
- Do not require owner email or password in the installer.
- Let the owner create the MOS account in Suite Manager on first browser visit.
- Reuse the existing Suite Manager UI framework for the first-run screen.
- Reuse the DigitalOcean smoke harness for real install validation once the no-owner path exists.

## Test Command

From the repo root:

```powershell
npm run v2:lab:test
```

This verifies the lab contract without starting Docker, touching host agents, or changing the current stack.

## Reference Branches

- `staging`: integration base for this branch.
- `feat/app-catalog-provisioning`: prototype reference for app catalog and package-projection lessons.

Do not merge the prototype branch wholesale into this lab. Copy or rebuild only the small pieces that survive review against the V2 goal.
