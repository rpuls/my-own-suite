# Decisions

This file records architectural decisions that should survive beyond a single issue or PR. Keep entries short, dated, and practical.

For documentation ownership rules, see [docs/README.md](./README.md).

## 2026-04-28: Self-Host Updates Are Host-Managed

Decision: The Suite Manager container must not update the host directly. USB self-host installs use a host-owned `mos-update-agent` systemd service, and Suite Manager talks to it through a controlled local API.

Reason: This matches the Railway and Home Assistant Supervisor pattern: the app can request an update, but infrastructure applies it. It keeps host control out of the web container while still enabling a friendly in-app update button.

Consequences:

- Railway-style deployments remain `notify-only`.
- Self-host deployments can use `managed` mode when the host agent is installed and reachable.
- Host-side updater changes need an explicit self-refresh path so future systemd/agent improvements do not require reflashing.

## 2026-04-28: Update Agent API Is Local-Only

Decision: The first managed self-host updater uses a Unix socket plus shared bearer token. It must not expose an HTTP port on the LAN or internet.

Reason: The updater has host-level effects. Keeping the transport local-only sharply reduces accidental exposure while still allowing Suite Manager to request controlled actions through a mounted socket.

Consequences:

- Self-host Compose mounts `/run/mos-update-agent` into Suite Manager.
- Suite Manager only enables managed apply actions when the configured local agent is reachable.
- Any future remote-management feature needs a separate security design.

## 2026-04-28: Branch Tracks Are For Hardware Testing

Decision: Stable installs should follow releases. Non-main self-host installs can follow a configured branch track, especially `staging`, for hardware testing before release.

Reason: The project needs real-machine validation without publishing official releases just to test branch work.

Consequences:

- USB installer config supports `REPO_REF`, `UPDATE_TRACK`, and `UPDATE_REF`.
- Test machines can subscribe to `staging`.
- The Updates UI should clearly show the active track.

## 2026-04-28: GitHub Issues Hold Task State

Decision: GitHub Issues are the source of truth for task-level work. Repo docs hold durable roadmap, decisions, and workflow context.

Reason: Issues and PRs are where Codex, humans, code review, and project status naturally meet. Repo docs are better for context that should survive issue closure.

Consequences:

- Do not add Markdown task lists for active implementation work unless they are intentionally temporary.
- Use `.github/ISSUE_TEMPLATE/codex-task.yml` for Codex-ready tasks.
- Use `docs/roadmap.md` for durable themes and `docs/decisions.md` for architecture decisions.
