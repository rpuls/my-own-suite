# Public installer endpoint

The stable entrypoint for `get.myownsuite.org` is hard-coded to `main` and serves released source after it reaches that branch. The development entrypoint for `get-dev.myownsuite.org` reads `INSTALL_BRANCH` from its repo-owned Wrangler configuration (currently `feat/app-platform-v2-lab`, later `staging`). `/install.sh` exposes either launcher for inspection.

For every request, the Worker asks GitHub for the configured branch tip, validates the returned full commit SHA, and emits a launcher pinned to that SHA. The machine therefore installs one immutable snapshot even if the branch moves during installation. No GitHub or Cloudflare API token is required by the Worker for this public repository.
