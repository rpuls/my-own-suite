# Stirling PDF MOS Package

This is an intentionally boring MOS app package. It exists to prove package discovery, manifest validation, projection inputs, and the eventual install lifecycle before MOS grows a catalog.

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

## Privacy controls

MOS sets `SYSTEM_ENABLEANALYTICS=false`, the upstream-supported system-wide control for disabling Stirling PDF analytics and suppressing its analytics consent prompt. This disables known optional PostHog and Scarf telemetry in the assessed 2.10.0 image; it is not evidence that the container makes no outbound requests. User-invoked features such as trusted timestamping can still contact an external service.
