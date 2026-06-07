# Codex Notes

This file is durable context for future Codex sessions. It should capture project-specific memory, current gotchas, and useful background that is not strict policy.

For mandatory agent rules, see [AGENTS.md](../AGENTS.md). For documentation ownership, see [docs/README.md](./README.md).

## Self-Host Update Notes

- The updater MVP is intentionally modeled after host-managed systems: Suite Manager requests updates, the host agent applies them.
- A staging-tracked USB install should eventually remove most reflashing during development.
- Reflashing may still be needed for installer/bootstrap changes until the host updater can refresh its own systemd units and host-side scripts.

## Current Project Habits

- `staging` is the practical hardware-testing branch.
- GitHub Issues are preferred for task state because Codex, PRs, review, and status all meet there.
- Repo docs should hold context that should still matter after an issue is closed.
- There is no long-lived repo roadmap document; use GitHub Issues for roadmap-like planning, backlog, and active task state.
- Temporary branch plans are allowed when useful for multi-session work, but they should be deleted or replaced with durable decisions/docs before merge.

## Useful Gotchas

- The USB installer path and the host updater path are related but not identical: installer/bootstrap changes may still require a reflash until the updater can self-refresh host-side files.
- Railway-like deployments should stay notify-only; the platform applies updates.
- Self-host managed updates must keep the host-control boundary explicit.
- For Homepage external service tiles, `href` is the public/browser URL and `mos.proxy.upstream` is the private target. Do not remove the protocol from `href`; hand-authored links should use full URLs such as `https://truenas.mos.example.com`.
- The default self-host domain remains `mos.home`. Real domains such as `mos.example.com` are optional user-provided config for local HTTPS. Broken external links during testing were caused by manually hardcoded old or wrong-domain hrefs, not by DNS-01 or built-in MOS route generation.
- MOS should not rewrite arbitrary user-authored Homepage `href` strings when `DOMAIN` changes. Safe regeneration belongs to MOS-managed tiles with `mos.public.mode: app-subdomain`, or to an explicit user-confirmed conversion.
