# Version 2.0

This folder is the clean-slate home for the MOS V2 launch platform.

Everything outside `version-2/` is the existing system. It is useful reference material, but V2 should not run through it by default. When old code contains a good idea, copy or rebuild the specific idea into this folder deliberately.

## First Slice

Build and validate the control plane before optional apps:

- Install Suite Manager, Homepage, Caddy, and required host agents.
- Do not require owner email or password in the installer.
- Let the owner create the MOS account in Suite Manager on first browser visit.
- Rebuild or copy only the Suite Manager UI primitives needed for the first-run screen.
- Reuse the DigitalOcean smoke harness for real install validation once the no-owner path exists.

## Test Command

From the repo root:

```powershell
npm --prefix version-2 test
```

This verifies the V2 contract without starting Docker, touching host agents, importing the old Suite Manager app, or changing the current stack.

## Reference Material

- `staging`: integration base for this branch.
- `feat/app-catalog-provisioning`: prototype reference for app catalog and package-projection lessons.
- `apps/suite-manager/`: old Suite Manager implementation and design inspiration.
- `scripts/smoke/digitalocean.cjs`: existing DigitalOcean smoke harness to adapt when V2 has an install path.

Do not merge the prototype branch wholesale into this workspace.
