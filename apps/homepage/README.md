#### Environment variables

- `HOMEPAGE_ALLOWED_HOSTS`: Allowed hostnames for Homepage (`hostname1,hostname2,...`).
- Any `${VAR_NAME}` used in `config/services.template.yaml`:
  - Example: `${SEAFILE_URL}`, `${VAULTWARDEN_URL}`, `${ONLYOFFICE_URL}`.
  - If not set (or empty), dependent tile is excluded from final dashboard.

#### Customizations in this project

- Homepage config is generated at container start from a template.
- `entrypoint.sh` runs `node /app/config-generator/dist/index.js /app/config` before starting Homepage.
- Source template: `config/services.template.yaml`
- Generated output: `config/services.yaml`
- Generator behavior:
  - Replaces `${ENV_VAR}` placeholders using runtime environment values.
  - If any placeholder in a service is unresolved, that full service is removed.
  - If a category has no remaining services, that category is removed.
- Result: tiles appear only when their required env values exist.

Files commonly edited for customization:
- `apps/homepage/config/services.template.yaml`: categories, tile order, names, descriptions, and icons.
- `apps/homepage/config/widgets.yaml`: widgets.
- `apps/homepage/config/bookmarks.yaml`: bookmarks.
- `apps/homepage/config/settings.yaml`: general dashboard settings.
- `apps/homepage/config/custom.css`: visual overrides layered on top of Homepage defaults.

Current defaults in this repo:
- Homepage does not pin a fixed `theme` or `color` in `settings.yaml`, so end users keep Homepage's built-in theme and palette switchers.
- `custom.css` gives Homepage the same MOS brand feel used elsewhere in the suite without removing Homepage's own theme controls.
- `widgets.yaml` includes a greeting, system glance widgets, datetime, and an Open-Meteo weather widget.
- The weather widget uses Homepage's Open-Meteo integration, which requires no API key and can use browser geolocation when Homepage is served from HTTPS or localhost.

Tile template example:

```yaml
- Storage:
    - Seafile:
        href: ${SEAFILE_URL}
        description: Self-hosted file sync and share
        icon: mdi-folder-sync
```

#### Operational commands

- If you changed `services.template.yaml` or other files under `apps/homepage/config`:
  - Rebuild Homepage image (from repo root): `npm run vps:rebuild`
- If you changed only env values in `deploy/vps/apps/homepage/.env`:
  - Restarting Homepage is enough.

#### Troubleshooting

- Check generated config inside container:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps exec homepage sh -c "cat /app/config/services.yaml"`
- Check generator logs:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps logs homepage --tail 200`
- Common issue:
  - Missing env var removes tile silently by design.



