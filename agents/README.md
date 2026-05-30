# My Own Suite Agents

This folder contains host-side agents that run outside Suite Manager for installations where My Own Suite owns the host.

Current structure:

- `selfhost/service/`: narrow service-control agent for USB/self-host installs
- `selfhost/update/`: managed update agent for USB/self-host installs

Future host agents should live here instead of creating new root folders. Keep deployment-specific installer assets under `deploy/`, and keep app containers under `apps/`.
