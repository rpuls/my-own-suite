# V2 System Agents

Host-side privileged agents live here.

Use this area for service, update, backup, and restore agents. Suite Manager talks to these agents through narrow local APIs instead of gaining broad host privileges.

## HTTPS Agent

`https/agent.cjs` is the first V2 privileged agent. It runs as root and exposes only status plus Cloudflare DNS-01 apply, commit, and rollback over `/run/mos-v2-https-agent/agent.sock`. The socket is writable only by the dedicated `mos-v2-agent` group.

The agent validates the exact structured request, verifies the pinned Caddy module, verifies the Cloudflare token and readable active zone, and stores the token only in `/etc/mos-v2/secrets/caddy-cloudflare.env` with mode `0600`. It creates a root-only checkpoint, atomically installs the secret and repo-rendered Caddyfile, validates and reloads Caddy, and restores the checkpoint on failure. Errors and logs are fixed and sanitized; they never include request values or command output.

Suite Manager persists active non-secret state before committing the short-lived checkpoint. If persistence fails it requests rollback. Suite Manager itself is never restarted during an HTTPS apply.
