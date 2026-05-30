# Roadmap

This file tracks durable project direction. GitHub Issues should hold task-level detail; this file should stay high-level enough that it remains useful across branches and releases.

For documentation ownership rules, see [docs/README.md](./README.md).

## Current Focus

- Stabilize the USB self-host installation path so a fresh machine can install My Own Suite with minimal terminal work.
- Define the offline backup and restore contract before managed updates become the normal path for systems holding important app data.
- Promote managed self-host updates from MVP to dependable staging workflow.
- Keep Railway-style deployments on notify-only updates, where the hosting platform remains responsible for applying changes.

## Near-Term

- Add a host-owned backup agent, following the managed-update agent pattern, so Suite Manager can offer no-SSH backup actions without giving the container broad host control.
- Add an offline suite backup plan that captures the MOS version/commit, update track, enabled profiles, env files, runtime customization files, and persistent Docker volumes as one restoreable state bundle.
- Add Suite Manager backup UI for detected external USB storage first, including device/free-space display, downtime warnings, start-backup action, progress/status recovery after Suite Manager restarts, and a conservative no-auto-format safety posture.
- Add a restore path that installs or checks out the backup's recorded MOS version before restoring app data, then allows normal forward updates only after the restored stack boots.
- Use a staging-tracked self-host install as the normal hardware test path:
  - `REPO_REF=staging`
  - `UPDATE_TRACK=branch`
  - `UPDATE_REF=staging`
- Make the self-host update agent refresh its own host-side files during updates, including systemd unit changes and updater script changes.
- Add safer update preflight checks before applying updates, including backup availability, disk space, clean working tree, Docker availability, and service availability.
- Improve update progress visibility in Suite Manager with useful status messages and logs.
- Confirm the `staging` branch update track works as the normal hardware test path after one fresh USB install.

## Later

- Add app-aware warm backups after the offline whole-suite backup/restore path is proven.
- Add pre-update restore points once the backup format has been validated on real self-host hardware.
- Add rollback strategy for failed updates.
- Add cancel/resume behavior or clear recovery guidance for interrupted updates.
- Add branch/track switching in the Updates UI for explicit feature testing.
- Add a host/server agent capability for narrow operational actions such as restarting Homepage after config saves, plus monitoring/status reporting. Railway-style installs should remain manual-restart with clear Suite Manager guidance because the platform owns service restarts.
- Explore VPS managed-update compatibility after the self-host path is stable.
- Add GitHub Project views for Backlog, Ready, In progress, Review, and Done once issue volume grows.

## Backup Architecture Direction

- Backups should be host-owned, not container-owned. Suite Manager should call a local backup agent over a narrow host bridge, similar to the self-host update agent.
- The primary user experience is offline external-drive backup: plug in a USB drive, open Suite Manager, choose the detected drive, acknowledge downtime, and start a cold whole-suite backup.
- The first backup mode should stop the MOS stack, write a manifest and data bundle to the selected destination, verify the result, restart the stack, and leave persistent job status that Suite Manager can show after services return.
- External drive detection should be conservative: inspect host block devices and mounted filesystems, show likely removable USB storage with size/free-space/writeability, and avoid formatting or writing to system disks in the first version.
- Local/internal disk destinations can be supported as a secondary destination type, but offline removable media is the trust-building default for cyberattack and accidental-update anxiety.
- Restore should be version-paired: read the backup manifest, install or check out the recorded MOS version/commit first, restore env/runtime config/volumes, boot the stack, and only then permit forward updates.

## Done Recently

- Delivered Suite Manager-owned Homepage runtime customization: persistent config lives under Suite Manager state, Homepage fetches it at startup, and the Customize screen provides CodeMirror-powered YAML/CSS/JS editing with YAML validation while preserving generated `services.yaml` behavior.
- Began the offline backup epic with a host-owned backup agent, Suite Manager Backup page, external destination detection, and persistent backup job state.
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
- The backup agent does not yet archive Docker volumes or perform automated restore.
- Rollback is not implemented.
- Update logs and preflight checks are still minimal in the UI.
