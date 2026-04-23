# Self-Host Managed Updates Smoke Test

This note is for validating the early host-side update agent on a Linux self-host machine.

## Expected installed pieces

After the self-host bootstrap runs, these should exist:

- systemd service: `mos-update-agent.service`
- socket path: `/run/mos-update-agent/agent.sock`
- state directory: `/var/lib/mos-update-agent`
- token file: `/etc/mos-update-agent/auth.token`
- updater config in repo: `<repo>/.mos-updater/config.json`

## Basic health check

Fastest path:

```bash
sudo mos-update health
```

Equivalent low-level form:

```bash
sudo systemctl status mos-update-agent.service --no-pager
curl --unix-socket /run/mos-update-agent/agent.sock http://localhost/healthz
```

Expected response:

```json
{"ok":true,"service":"mos-update-agent"}
```

## Authenticated status check

Fastest path:

```bash
sudo mos-update status
```

Equivalent low-level form:

```bash
TOKEN="$(sudo cat /etc/mos-update-agent/auth.token)"
curl --unix-socket /run/mos-update-agent/agent.sock \
  -H "Authorization: Bearer ${TOKEN}" \
  http://localhost/v1/status
```

Check for:

- `service: "mos-update-agent"`
- `updaterStatus.track`
- `currentJob` or `lastJob`

## Start an update job

Fastest path:

```bash
sudo mos-update start --target latest
```

Equivalent low-level form:

```bash
TOKEN="$(sudo cat /etc/mos-update-agent/auth.token)"
curl --unix-socket /run/mos-update-agent/agent.sock \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"target":"latest","initiator":"manual-smoke-test"}' \
  http://localhost/v1/jobs
```

Expected response:

- HTTP `202`
- job payload with an `id`

## Poll the job

Fastest path:

```bash
sudo mos-update job --id <job-id>
```

Equivalent low-level form:

```bash
JOB_ID="<job-id>"
TOKEN="$(sudo cat /etc/mos-update-agent/auth.token)"
curl --unix-socket /run/mos-update-agent/agent.sock \
  -H "Authorization: Bearer ${TOKEN}" \
  "http://localhost/v1/jobs/${JOB_ID}"
```

Check for transitions such as:

- `queued`
- `running`
- `succeeded`
- `failed`

## Useful host-side files

- updater state: `<repo>/.mos-updater/state.json`
- current agent job: `/var/lib/mos-update-agent/current-job.json`
- per-job records: `/var/lib/mos-update-agent/jobs/*.json`

## Current limitations

- This MVP agent is host-side only.
- Suite Manager UI wiring is still a separate step.
- Rollback and backups are not implemented yet.
