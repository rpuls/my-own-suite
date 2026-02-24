# Stirling PDF

Self-hosted PDF toolbox for merge, split, convert, OCR, and signing workflows.

## Customizations in this project

- VPS deployment uses the official `stirlingtools/stirling-pdf` image directly.
- App data/config/logs are persisted using named Docker volumes.

## Environment variables

- `TZ`: Container timezone (optional).
- `LANGS`: Language list for OCR and UI support (optional).
- `SERVER_HOST`: Public URL for the service (optional).

## Official website

- https://github.com/Stirling-Tools/Stirling-PDF
