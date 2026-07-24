# Stirling PDF MOS Package

## Environment Variables

- `SERVER_HOST`: Projected from the app public URL.
- `SYSTEM_ENABLEANALYTICS=false`: Disables Stirling PDF analytics (see Privacy Controls).

## Volumes And Persistence

- `configs:/configs`: Server configuration.
- `custom-files:/customFiles`: Custom assets.
- `logs:/logs`: Application logs.
- `pipeline:/pipeline`: Saved automation pipelines.
- `training-data:/usr/share/tessdata`: OCR language data.

Disable preserves these volumes so the app can be started again. Uninstall removes the app containers, routes, Suite Manager state, and these Docker volumes so the package returns to a clean installable state.

## Setup

No user inputs are required; the package installs with an empty setup form.

## Health Check

- `http://stirling-pdf:8080/api/v1/info/status`

## Privacy Controls

MOS sets `SYSTEM_ENABLEANALYTICS=false`, the upstream-supported system-wide control for disabling Stirling PDF analytics and suppressing its analytics consent prompt. This disables known optional PostHog and Scarf telemetry in the assessed 2.10.0 image; it is not evidence that the container makes no outbound requests. User-invoked features such as trusted timestamping can still contact an external service.
