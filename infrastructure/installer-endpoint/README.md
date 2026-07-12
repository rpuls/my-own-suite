# Public installer endpoint

This Worker serves `curl -fsSL https://get.myownsuite.org | sudo bash`. It requires an approved full commit SHA, verifies the checkout, and delegates to the shared bootstrap renderer. `/install.sh` exposes the launcher for inspection.

Deploy with `npx wrangler deploy --config infrastructure/installer-endpoint/wrangler.toml --var INSTALL_REF:<40-character-commit-sha>`, attach the `get.myownsuite.org` Worker custom domain, then validate it on fresh Ubuntu 24.04.
