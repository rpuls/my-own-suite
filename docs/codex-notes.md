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

## Useful Gotchas

- The USB installer path and the host updater path are related but not identical: installer/bootstrap changes may still require a reflash until the updater can self-refresh host-side files.
- Railway-like deployments should stay notify-only; the platform applies updates.
- Self-host managed updates must keep the host-control boundary explicit.
