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

Disable preserves these volumes so the app can be started again. Uninstall removes the app containers, routes, Suite Manager state, and these Docker volumes so the package returns to a clean installable state.

## Setup

No user inputs are required for the first package version. `SERVER_HOST` is projected from the app public URL when the lifecycle engine exists.
