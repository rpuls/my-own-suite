# Codex Notes

Durable working context for AI agent sessions (Codex, Claude Code, and others). Mandatory rules live in [AGENTS.md](../AGENTS.md); documentation ownership lives in [docs/README.md](./README.md).

## Project Habits

- `staging` is the practical hardware-testing branch.
- GitHub Issues are preferred for task state, backlog, and roadmap-like planning.
- Repo docs should hold context that still matters after an issue is closed.
- Temporary branch plans are allowed for multi-session work, but must be deleted, converted to issues, or reduced to durable decisions before merge.
- Keep operator runbooks single-source. Hyper-V and DigitalOcean smoke commands live in `scripts/README.md`; do not duplicate full command runbooks here.

## MOS Hyper-V SSH For Codex

Use this when the user has run the MOS Hyper-V USB smoke and gives Codex the VM IPv4. The IP changes between resets; login details usually do not.

- Do not ask the user to upload SSH keys into the VM. The Hyper-V autoinstall enables password SSH for the Linux user.
- Read the Linux username/password from `infrastructure/self-host/autoinstall/installer-config/selfhost-installer.env`. `USERNAME` defaults to `mos`; `LINUX_PASSWORD` is the SSH/sudo password. Do not print the password in chat.
- First check port 22 from Windows:

```powershell
Test-NetConnection -ComputerName <vm-ip> -Port 22 | Select-Object ComputerName,RemotePort,TcpTestSucceeded
```

- If OpenSSH key auth fails, that does not mean SSH is broken. `plink.exe` from PuTTY works well for non-interactive password SSH and is commonly installed at `C:\Program Files\PuTTY\plink.exe`.
- Pin the host key before using `plink`. If needed, let OpenSSH record the host key with `StrictHostKeyChecking=accept-new`, then inspect the actual known-hosts file from `ssh -G`.
- Expected installed paths:
  - checkout: `/opt/mos/repo`
  - Suite Manager state: `/var/lib/mos/suite-manager`
  - app secrets: `/var/lib/mos/suite-manager/app-secrets`
- Expected service names:
  - `mos-suite-manager`
  - `mos-app-agent`
  - `mos-homepage`
  - `mos-homepage-agent`
  - `mos-https-agent`
- Keep live checks read-only unless the user explicitly approves a reversible tamper test. Safe tamper tests include stopping/restarting an app container or service to verify status recovery; do not delete volumes, app data, DNS secrets, or the VM unless explicitly confirmed.

## Useful Gotchas

- USB installer and managed updater paths are related but not identical. Bootstrap changes may still require a reflash until updater self-refresh of host scripts/units is proven.
- Railway-like deployments should stay notify-only; the platform applies updates.
- Self-host managed updates must keep the host-control boundary explicit.
- For Homepage external service tiles, `href` is the public/browser URL and `mos.proxy.upstream` is the private target.
- Homepage `icon:` values use the Material Design Icons hyphen form (`mdi-tag-text-outline`), not the colon form (`mdi:tag-text-outline`). Ref: https://gethomepage.dev/configs/services/#icons
- MOS should not rewrite arbitrary user-authored Homepage URLs when the domain changes. Safe regeneration belongs to MOS-managed structured tiles or explicit user-confirmed conversion.
