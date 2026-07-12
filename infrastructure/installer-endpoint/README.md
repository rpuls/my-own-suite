# Public installer endpoint

The same Worker code powers two installer channels. `get.myownsuite.org` has `INSTALL_BRANCH=main` and serves the current released source after it reaches `main`. `get-dev.myownsuite.org` has `INSTALL_BRANCH` set to the branch under test (currently `feat/app-platform-v2-lab`, later `staging`). `/install.sh` exposes either launcher for inspection.

For every request, the Worker asks GitHub for the configured branch tip, validates the returned full commit SHA, and emits a launcher pinned to that SHA. The machine therefore installs one immutable snapshot even if the branch moves during installation. No GitHub or Cloudflare API token is required by the Worker for this public repository.
