# Roadmap

This file tracks durable project direction. GitHub Issues should hold task-level detail; this file should stay high-level enough that it remains useful across branches and releases.

For documentation ownership rules, see [docs/README.md](./README.md).

## Current Focus

- Stabilize the USB self-host installation path so a fresh machine can install My Own Suite with minimal terminal work.
- Promote managed self-host updates from MVP to dependable staging workflow.
- Keep Railway-style deployments on notify-only updates, where the hosting platform remains responsible for applying changes.

## Near-Term

- Use a staging-tracked self-host install as the normal hardware test path:
  - `REPO_REF=staging`
  - `UPDATE_TRACK=branch`
  - `UPDATE_REF=staging`
- Make the self-host update agent refresh its own host-side files during updates, including systemd unit changes and updater script changes.
- Add safer update preflight checks before applying updates, including disk space, clean working tree, Docker availability, and service availability.
- Improve update progress visibility in Suite Manager with useful status messages and logs.
- Confirm the `staging` branch update track works as the normal hardware test path after one fresh USB install.

## Later

- Add backup and restore planning before updates that touch persistent app data.
- Add rollback strategy for failed updates.
- Add cancel/resume behavior or clear recovery guidance for interrupted updates.
- Add branch/track switching in the Updates UI for explicit feature testing.
- Explore VPS managed-update compatibility after the self-host path is stable.
- Add GitHub Project views for Backlog, Ready, In progress, Review, and Done once issue volume grows.

## Done Recently

- Built a managed self-host updater MVP using a host-owned update agent and Suite Manager UI integration.
- Added branch-track update detection so staging and feature branches can be tested without publishing releases.
- Added a self-host Compose override so Suite Manager can talk to the local update agent without giving the container broad host control.

## Completed MVP Criteria

- A self-host install can expose a managed updater service.
- Suite Manager can detect that service.
- Suite Manager can start an update job through that service.
- The stack returns after update downtime in real hardware testing.
- Persistent Docker volumes are preserved by the Compose update path.
- Railway behavior remains notify-only.

## Known MVP Gaps

- The host update agent does not yet refresh its own installed systemd unit and helper files during update.
- Backups are not implemented.
- Rollback is not implemented.
- Update logs and preflight checks are still minimal in the UI.
