# Stirling PDF V2 Package

This is the first intentionally boring V2 app package. It exists to prove package discovery, manifest validation, projection inputs, and the eventual install lifecycle before MOS grows a catalog.

## Runtime Shape

- Primary service: `stirling-pdf`
- Dockerfile: `Dockerfile`
- Internal HTTP port: `8080`
- Public route host: `stirling-pdf.<mos-base-domain>`
- Health endpoint: `/api/v1/info/status`

## Persistence

The package declares persistent mounts for:

- `/configs`
- `/customFiles`
- `/logs`
- `/pipeline`
- `/usr/share/tessdata`

The first lifecycle implementation should preserve these volumes on disable and default uninstall. Destructive removal should require a separate explicit confirmation.

## Setup

No user inputs are required for the first package version. `SERVER_HOST` is projected from the app public URL when the lifecycle engine exists.
