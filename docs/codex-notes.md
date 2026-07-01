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
- Keep operator runbooks single-source: V2 Hyper-V and DigitalOcean smoke commands live in `version-2/scripts/README.md`; Codex notes should point there instead of duplicating command steps.

## V2 Hyper-V SSH For Codex

Use this when the user has run the V2 Hyper-V USB smoke and gives Codex the VM IPv4. The IP changes between resets; the SSH login details usually do not.

- Do not ask the user to upload SSH keys into the VM. The Hyper-V autoinstall enables password SSH for the Linux user.
- Read the Linux username/password from `deploy/self-host/autoinstall/installer-config/selfhost-installer.env`. `USERNAME` defaults to `mos` when it is not set; `LINUX_PASSWORD` is the SSH/sudo password. Do not print the password in chat.
- First check port 22 from Windows:

```powershell
Test-NetConnection -ComputerName <vm-ip> -Port 22 | Select-Object ComputerName,RemotePort,TcpTestSucceeded
```

- If OpenSSH has no key for the VM, `ssh -o BatchMode=yes ...` will fail with `Permission denied (publickey,password)`. That is expected and does not mean SSH is broken.
- `plink.exe` from PuTTY works well for non-interactive password SSH. It is commonly installed at `C:\Program Files\PuTTY\plink.exe` on this machine.
- Pin the host key before using `plink`. One safe pattern is to let OpenSSH record the host key while forcing non-interactive auth failure, then ask OpenSSH which known-hosts file it actually uses in the Codex shell and read the fingerprint from that file. In this environment it may be `C:\Users\CodexSandboxOffline\.ssh\known_hosts` instead of `$env:USERPROFILE\.ssh\known_hosts`.

```powershell
$ip = '<vm-ip>'
ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "mos@$ip" "hostname"
$knownHosts = ((ssh -G $ip | Select-String '^userknownhostsfile\s+(.+?)(?:\s+\S+)?$').Matches[0].Groups[1].Value)
ssh-keygen -F $ip -f $knownHosts
ssh-keygen -lf $knownHosts | Select-String $ip
```

- Then use `plink` with the pinned `SHA256:...` fingerprint and the password read from the local env file:

```powershell
$ip = '<vm-ip>'
$cfg = Get-Content -LiteralPath 'deploy\self-host\autoinstall\installer-config\selfhost-installer.env'
$userLine = $cfg | Where-Object { $_ -match '^\s*USERNAME\s*=' } | Select-Object -Last 1
$user = if ($userLine) { (($userLine -split '=', 2)[1]).Trim().Trim('"').Trim("'") } else { 'mos' }
$password = (($cfg | Where-Object { $_ -match '^\s*LINUX_PASSWORD\s*=' } | Select-Object -Last 1) -split '=', 2)[1].Trim().Trim('"').Trim("'")
$hostKey = '<SHA256:fingerprint-from-ssh-keygen>'
& 'C:\Program Files\PuTTY\plink.exe' -ssh -batch -hostkey $hostKey -pw $password "$user@$ip" "hostname; whoami"
```

- For sudo-backed read-only checks, feed the same password to `sudo -S` over SSH. Keep commands read-only unless the user explicitly approves a reversible tamper test:

```powershell
$remote = "printf '%s\n' '$password' | sudo -S sh -c 'systemctl list-units ''mos-v2*'' --no-pager --plain; docker ps'"
& 'C:\Program Files\PuTTY\plink.exe' -ssh -batch -hostkey $hostKey -pw $password "$user@$ip" $remote
```

- The V2 checkout is expected at `/opt/mos-v2/repo`, Suite Manager state at `/var/lib/mos-v2/suite-manager`, app secrets at `/var/lib/mos-v2/suite-manager/app-secrets`, and V2 services are named `mos-v2-suite-manager`, `mos-v2-app-agent`, `mos-v2-homepage`, `mos-v2-homepage-agent`, and `mos-v2-https-agent`.
- If `plink` is unavailable, ask the user for their exact SSH command or ask them to run a read-only command bundle and paste the output. Do not spend time trying to invent a new key workflow.

## Temporary Branch Plan: Own-Infra Self-Host Convergence

Branch: `feat/own-infra-selfhost-convergence`

This plan is branch-scoped. Delete it, convert remaining work to GitHub Issues, or replace it with durable docs before merging.

Goal: collapse the current VPS/local and USB self-host split into one MOS own-infra runtime, with USB and cloud-machine installers feeding the same Ubuntu 24.04 bootstrap and host-agent flow.

### Product Model

- [x] Update public deployment framing to two top-level choices: Platform and Self-hosted.
- [x] Keep Railway as the first Platform provider for ultra-fast testing, public exposure, and referral/commission potential.
- [x] Reframe VPS/cloud servers as a Self-hosted installer option, not a separate system.
- [x] Treat `deploy/vps` as the local/development Compose substrate until a low-risk rename is worth doing.
- [x] Replace "VPS/local" wording in user-facing docs where it implies a third deployment architecture.
- [ ] Add provider listing guidance for cloud-machine hosts that support Ubuntu 24.04 cloud-init/user-data without requiring provider-specific source changes.

### Runtime Contract

- [ ] Keep Ubuntu Server 24.04 LTS as the only supported own-infra OS target.
- [ ] Define one own-infra marker/config file for installed machines, separate from installer-specific details.
- [x] Ensure USB and cloud-machine installs both write the same first-boot handoff values.
- [x] Route USB, cloud-init, and SSH cloud installs through one shared self-host installer core after `/etc/mos-selfhost.env` exists.
- [ ] Ensure both installers produce the same `docker-compose.selfhost.yml`, `.env.selfhost`, host agents, update track config, and generated Caddy env/snippets.
- [ ] Preserve capability-gated Suite Manager behavior instead of adding deployment-mode conditionals.
- [ ] Keep manual `npm run vps:*` commands as developer/operator tooling, not the main user promise.
- [ ] Remove installer-time owner credential collection after Suite Manager first-run owner creation and app catalog provisioning exist.

### Cloud Installer

- [x] Add a provider-agnostic cloud-init/user-data generator using the same core fields as `selfhost-installer.env.template`.
- [x] Make the generated cloud-init install baseline packages, write `/etc/mos-selfhost.env`, clone the repo/ref, and run `scripts/selfhost/bootstrap-ubuntu.sh`.
- [x] Add a cloud SSH bootstrap script for the "fresh Ubuntu server, one command, prompts, wait" path.
- [ ] Support owner name, owner email, owner password, Linux user/password or SSH key, hostname, timezone, stack domain, repo URL/ref, and update track/ref.
- [ ] Replace owner prompts/env requirements with browser-based Suite Manager owner setup once the app catalog alpha work moves app-specific provisioning out of first boot.
- [ ] Decide whether cloud installs default to `MOS_TLS_MODE=off` plus normal public HTTP/HTTPS provider docs, or first-class Caddy public TLS through standard HTTP-01/Cloudflare DNS-01.
- [ ] Document the unavoidable user steps: choose Ubuntu 24.04, paste user-data, create server, point wildcard DNS, open Suite Manager.
- [ ] Test on at least one real VPS/cloud provider before advertising the path as supported.

### USB Installer

- [ ] Keep the USB installer as the own-hardware front door for the same own-infra runtime.
- [ ] Align USB installer terminology with the shared Self-hosted model.
- [ ] Keep the "explicit human boot menu choice" safety behavior.
- [ ] Verify USB bootstrap still shares the same cloud-machine runtime contract after any config/marker changes.

### HTTPS And Routing

- [ ] Separate LAN/private HTTPS guidance from public cloud-server HTTPS guidance.
- [ ] Keep Cloudflare DNS-01 for private LAN/self-host cases where public inbound access is not desired.
- [ ] Investigate whether cloud installs should rely on Caddy-managed ACME HTTP-01 by default when public DNS points at the VPS.
- [ ] Avoid assuming VPS providers provide app HTTPS automatically unless the MOS stack is actually behind a provider-managed proxy.
- [ ] Keep Caddy as the MOS-owned routing layer for own-infra installs.

### Deprecations And Cleanup

- [x] Deprecate the abandoned Cloudflared tunnel script and remove it from recommended docs.
- [x] Audit docs and scripts for stale `selfhost:cloudflared` references.
- [ ] Decide whether `deploy/vps/README.md` should become local/dev Compose reference or be renamed later.
- [ ] Move any unfinished checklist items to GitHub Issues before merge.

## Useful Gotchas

- The USB installer path and the host updater path are related but not identical: installer/bootstrap changes may still require a reflash until the updater can self-refresh host-side files.
- Railway-like deployments should stay notify-only; the platform applies updates.
- Self-host managed updates must keep the host-control boundary explicit.
- For Homepage external service tiles, `href` is the public/browser URL and `mos.proxy.upstream` is the private target. Do not remove the protocol from `href`; hand-authored links should use full URLs such as `https://truenas.mos.example.com`.
- The default self-host domain remains `mos.home`. Real domains such as `mos.example.com` are optional user-provided config for local HTTPS. Broken external links during testing were caused by manually hardcoded old or wrong-domain hrefs, not by DNS-01 or built-in MOS route generation.
- MOS should not rewrite arbitrary user-authored Homepage `href` strings when `DOMAIN` changes. Safe regeneration belongs to MOS-managed tiles with `mos.public.mode: app-subdomain`, or to an explicit user-confirmed conversion.
