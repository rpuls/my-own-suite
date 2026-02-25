#### Environment variables

- `TZ`: Container timezone (optional).
- `LANGS`: Language list for OCR and UI support (optional).
- `SERVER_HOST`: Public URL for the service (optional).

#### Volumes and persistence

- Required for persistent users/settings: mount a volume to `/configs`.
- Recommended additional mounts when available:
  - `/pipeline`
  - `/usr/share/tessdata`
  - `/logs`
  - `/customFiles`
- If your deployment platform supports only one persistent volume per service, prioritize `/configs`.

#### Health check

- Recommended HTTP health endpoint: `/api/v1/info/status`

