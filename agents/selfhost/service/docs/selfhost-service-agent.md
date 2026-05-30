# Self-Host Service Agent

This note is for validating the host-side service agent on a Linux self-host machine.

After host-agent reconciliation runs, these should exist:

- systemd service: `mos-service-agent.service`
- socket path: `/run/mos-service-agent/agent.sock`
- token file: `/etc/mos-service-agent/auth.token`
- CLI helper: `mos-service`

Useful local checks:

```bash
sudo systemctl status mos-service-agent.service --no-pager
curl --unix-socket /run/mos-service-agent/agent.sock http://localhost/healthz
sudo mos-service status
sudo mos-service restart --service homepage
```

The service agent is intentionally local-only. It exposes a Unix socket plus bearer token, and only supports explicit MOS service actions. Future monitoring, warning, and metrics analyzers should extend this agent through named capabilities rather than giving Suite Manager broad host command access.
