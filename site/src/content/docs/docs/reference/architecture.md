---
title: How MOS works
description: The technical architecture of My Own Suite — one origin, a pinned Caddy build, an unprivileged control plane, and a strict host-agent boundary.
---

This section is for readers who want to see the machinery. Nothing here is required to use the suite — but all of it is inspectable in the [repository](https://github.com/rpuls/my-own-suite), and these docs are generated from the same source of truth the platform runs from.

## One machine, one origin

A MOS install is a single Ubuntu 24.04 machine running a small set of systemd services:

- **Caddy** is the only public entry point, on ports 80/443. It is not distro Caddy: MOS builds a version-pinned Caddy (currently 2.10.2) with the Cloudflare DNS module compiled in, installs it to `/usr/local/libexec/mos/`, and verifies the module list at install time.
- **Suite Manager** (Node.js) listens only on loopback `127.0.0.1:3100`. It owns the `home.<domain>` origin: it serves the control room under `/suite-manager/`, authenticates every request to the origin, and reverse-proxies everything else to Homepage.
- **Homepage** (the dashboard) runs as a digest-pinned container on loopback `127.0.0.1:3200`, with no route of its own — it is only reachable through Suite Manager's session check. An unauthenticated visitor never sees your dashboard.
- **Installed apps** get their own hosts (`<app>.<domain>`) routed by Caddy to loopback ports, declared by each [app package](/docs/reference/app-packages/).

## The privilege boundary

The core security decision in MOS: **the web application never performs privileged host actions.** Suite Manager runs unprivileged (as the `mos` system user). Anything that touches the host — Docker, certificates, systemd, disks — is delegated to small root-owned [host agents](/docs/reference/host-agents/), each reachable only over a local Unix socket, each exposing a handful of narrow, validated operations rather than arbitrary command access. A compromise of the web layer does not hand out root; an agent can only do the few things it was built to do.

## State and layout on disk

| Path | Contents |
| --- | --- |
| `/opt/mos/repo` | The MOS checkout the *control plane* runs from — Suite Manager, the agents, the units |
| `/var/lib/mos/suite-manager` | Suite Manager state — transactional SQLite (owner, sessions, app instances, operations) and app secrets |
| `/var/lib/mos/app-packages` | Installed app snapshots, root-owned (`root:mos-agent`, mode `2750`) — the definition each app actually runs from |
| `/var/lib/mos/suite-manager/app-candidates` | Scratch space for one package download at a time; swept back inside its bounds before each download |
| `/var/lib/mos/homepage/config` | Your dashboard's YAML configuration |
| `/etc/caddy/` | The base Caddyfile plus MOS-owned route snippets for Homepage and apps |
| `/etc/mos/secrets/` | Root-only secrets (e.g. the Cloudflare API token as a Caddy env file, mode 0600) |

The split between the last two matters: the checkout is the control plane's code, but an installed app runs from its own snapshot under `/var/lib/mos/app-packages`. An app stays inspectable and manageable even if the repo checkout is gone, and editing a repo package after install changes nothing that's running.

Secrets follow a redaction discipline end to end: generated app secrets live in Suite Manager's state and are materialized for an agent only per apply-request; the Cloudflare token is written once to its root-only file and is never returned by any API.

## Install front doors

Every install records how it arrived — its *front door*: `usb-autoinstall`, `ssh-bootstrap`, `cloud-init`, `public-vps`, or the DigitalOcean validation harness. All five render from **one shared bootstrap contract** (`scripts/installers/bootstrap-contract.cjs`), so a USB install and a cloud install produce the same machine. The front door then gates context-dependent features: the private-LAN [DNS-01 HTTPS flow](/docs/guides/https-domain/) is offered on self-host front doors and blocked on cloud ones, and the disposable lab-reset agent exists only on USB lab installs.

## Determinism and supply chain

- App containers are built from a digest-verified [package snapshot](/docs/reference/app-packages/) — never a repository-relative build path — and the base images in those Dockerfiles are pinned by immutable digest, never floating tags.
- The Homepage runtime image is digest-pinned; the Caddy build is version-pinned and module-verified.
- [Managed updates](/docs/guides/updates/) re-apply the whole repo-owned surface (units, agents, Caddy wiring) via a single reconciliation script, so an updated control plane converges on the same state a fresh install would.
- Installed apps are deliberately outside that convergence: each keeps its snapshot, and a core update never silently rebuilds an app from newer repo files. Apps update on their own, one transaction at a time.
