# Stirling PDF

Self-hosted PDF toolbox for merge, split, convert, OCR, and signing workflows.

## Customizations in this project

- A lightweight Dockerfile. Single source of truth for modifications or version lock-in.
- VPS deployment uses the official `stirlingtools/stirling-pdf` runtime image.
- App data/config/logs are persisted using named Docker volumes.

## Environment variables

- `TZ`: Container timezone (optional).
- `LANGS`: Language list for OCR and UI support (optional).
- `SERVER_HOST`: Public URL for the service (optional).

## Persistence

- Required for persistent users/settings: mount a volume to `/configs`.
- Recommended additional mounts when available:
  - `/pipeline`
  - `/usr/share/tessdata`
  - `/logs`
  - `/customFiles`
- If your deployment platform supports only one persistent volume per service, prioritize `/configs`.

## Health check

- Recommended HTTP health endpoint: `/api/v1/info/status`

## Official website

- https://github.com/Stirling-Tools/Stirling-PDF
