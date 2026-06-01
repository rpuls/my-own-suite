# Decisions

This file records architectural decisions that should survive beyond a single issue or PR. Keep entries short, dated, and practical.

For documentation ownership rules, see [docs/README.md](./README.md).

## 2026-06-01: Homepage YAML Is The Service Layout Source

Decision: Homepage YAML remains the user-facing source of truth for dashboard layout, service grouping, tile order, names, descriptions, icons, widgets, and visibility. MOS will not introduce a separate full service-registry document as the first source of truth for service/dashboard/proxy configuration. Instead, MOS may add small optional `mos` annotations to Homepage service tiles for metadata that Homepage does not model, starting with external-service proxy details for generated Caddy config.

Reason: Homepage and Caddy are established, documented tools that technical users can already configure directly. A new proprietary registry would be easier for MOS internals but harder for users to recognize, search, copy, and ask tools for help with. Keeping Homepage YAML as the layout document lets Suite Manager build friendly add/edit flows later without rebuilding the whole Homepage dashboard editor.

Consequences:

- Homepage owns advanced dashboard layout.
- Suite Manager should manage common service workflows and safe subsets of config, not become a full interactive Homepage layout clone.
- Caddy generation should read explicit `mos.proxy` annotations from Homepage tiles instead of raw Caddy snippets or a separate MOS registry.
- External services are metadata-only from MOS's perspective; integrated apps remain distinct because MOS owns their lifecycle.
- Generated Caddy config must be previewed and validated before any future apply/reload path.
- Existing static Caddy routes and default domain behavior must remain compatible during migration.

## 2026-05-29: Homepage Config Is Suite Manager-Owned

Decision: Homepage remains YAML-first, but persisted runtime customization is owned by Suite Manager. Homepage fetches an allow-listed config export from Suite Manager during container startup, writes it into its local config directory, then runs the existing `services.template.yaml` to `services.yaml` generator before starting the stock Homepage server.

Reason: Railway does not support sharing one persistent volume between services, and build-time fetching cannot rely on private service networking or persist generated files into runtime state. Startup sync keeps Homepage close to stock, avoids dirty source checkouts, and lets Suite Manager own the editor, storage, reset, and export API.

Consequences:

- Suite Manager stores editable Homepage YAML/CSS/JS under its own persistent state directory.
- Homepage does not require a persistent config volume for customization.
- `services.yaml` remains generated output and is not user-editable.
- Runtime config changes apply after Homepage restarts and fetches the latest Suite Manager export.
- The Homepage-to-Suite-Manager export uses a shared private bearer token.

## 2026-05-30: Self-Host Host Agents Are Repo-Reconciled

Decision: USB self-host installs should keep first-boot responsibilities small and let the repo reconcile host-side agents after checkout. Host agents live under `agents/selfhost/`, and `system:migrate` may install or refresh them on machines marked as self-host.

Reason: New service, backup, restore, monitoring, update, and proxy-management capabilities should not require reflashing the USB installer. The installer should install the OS, baseline tools, repo checkout, and initial settings; the repo should own ongoing app and agent setup.

Consequences:

- Existing self-host machines can gain new host agents through managed updates or a root-run repo migration path.
- Suite Manager should prefer capability detection from reachable agents over broad platform-mode flags.
- Agent APIs must stay narrow, local-only, and token-protected because they perform host-level actions.
- Fresh bootstrap and managed updates should share the same host-agent reconciliation path.

## 2026-05-30: Offline Backups Are Host-Owned

Decision: Offline suite backups use a host-owned `mos-backup-agent`. Suite Manager talks to it over a token-protected local Unix socket, and the container only receives the socket and token file mounts.

Reason: Whole-suite snapshots need host visibility into mounted external drives and, later, Docker volumes and stack lifecycle. That control should stay in a narrow host agent instead of broadening Suite Manager container privileges.

Consequences:

- Suite Manager enables backup actions only when the backup agent is reachable and advertises the needed capability.
- External backup destinations are detected by the host agent, initially under `/media`, `/mnt`, and `/run/media`.
- Restore remains version-paired and conservative until the backup bundle format is validated on real self-host hardware.

## 2026-04-28: Self-Host Updates Are Host-Managed

Decision: The Suite Manager container must not update the host directly. Self-host installs use a host-owned `mos-update-agent` systemd service, and Suite Manager talks to it through a controlled local API.

Reason: This matches the Railway and Home Assistant Supervisor pattern: the app can request an update, but infrastructure applies it. It keeps host control out of the web container while still enabling a friendly in-app update action.

Consequences:

- Hosted or agent-less deployments show manual/notify guidance.
- Self-host deployments expose managed update actions only when the update agent is installed, reachable, and advertises the needed capability.
- Host-side updater changes need an explicit self-refresh path so future systemd/agent improvements do not require reflashing.

## 2026-04-28: Update Agent API Is Local-Only

Decision: Managed self-host updater actions use a Unix socket plus shared bearer token. They must not expose an HTTP port on the LAN or internet.

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

## 2026-04-30: System State Changes Have Two Update Tracks

Decision: Runtime `.env.template` files describe the latest supported app contract. Managed-platform deployments keep their environment variables and infrastructure state user-owned and should fail clearly when required variables no longer match the current contract. Repo-managed VPS/self-host installs use an explicit `system:migrate` phase before `vps:init` so known historical state changes can be repaired without asking the user to SSH into generated files.

Reason: Railway-like platforms already provide an env-var UI and the project cannot safely mutate platform resources. Own-infra installs have no friendly platform UI, so the repo must own small, named migrations for compatibility breaks while keeping `vps-init` focused on rendering the current templates.

Consequences:

- New app env requirements belong in the relevant `.env.template` and technical README first.
- Historical compatibility fixes for own-infra installs belong in `scripts/migrations/`, not inline in `scripts/vps-init.cjs`.
- Migrations must be idempotent and preserve existing secrets instead of generating replacements for already-provisioned services.
- System migrations may repair env files, generated service config, local state files, directory layout, or other repo-owned own-infra state.
- Managed-platform compatibility problems should point users at the current template/README rather than silently rewriting platform variables.

## 2026-04-28: GitHub Issues Hold Task State

Decision: GitHub Issues are the source of truth for task-level work, backlog, and roadmap-like planning. Repo docs hold durable architecture decisions, project workflow rules, and working context that should still matter after an issue is closed.

Reason: Issues and PRs are where Codex, humans, code review, and status all meet. Repo docs are better for context that should survive issue closure.

Consequences:

- Do not keep long-lived task lists or roadmap documents in repo docs.
- Temporary branch plans are allowed only while actively useful and should be removed or replaced before merge.
- Use `.github/ISSUE_TEMPLATE/codex-task.yml` for Codex-ready tasks.
- Use `docs/decisions.md` for architecture decisions and `docs/codex-notes.md` for durable working context.
