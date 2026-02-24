# Homepage

Dashboard service for My Own Suite.

## Customizations in this project

- Homepage config is generated at container start from a template.
- `entrypoint.sh` runs `node /app/config-generator/dist/index.js /app/config` before starting Homepage.
- Source template: `config/services.template.yaml`
- Generated output: `config/services.yaml`
- Generator behavior:
  - Replaces `${ENV_VAR}` placeholders using runtime environment values.
  - If any placeholder in a service is unresolved, that full service is removed.
  - If a category has no remaining services, that category is removed.
- Result: tiles appear only when their required env values exist.

## Environment variables

- `HOMEPAGE_ALLOWED_HOSTS`: Allowed hostnames for Homepage (`hostname1,hostname2,...`).
- Any `${VAR_NAME}` used in `config/services.template.yaml`:
  - Example: `${SEAFILE_URL}`, `${VAULTWARDEN_URL}`.
  - If not set (or empty), dependent tile is excluded from final dashboard.

## How to edit tiles

1. Edit `apps/homepage/config/services.template.yaml`.
2. Use placeholder URLs for tiles that should be conditional:
   - `href: ${SEAFILE_URL}`
3. Use static URLs for always-visible tiles:
   - `href: https://example.com`
4. Keep Homepage YAML structure:
   - Category is a map key.
   - Category value is a list of services.
   - Service item shape is `ServiceName: { href, description, icon }`.

Example:

```yaml
- Storage:
    - Seafile:
        href: ${SEAFILE_URL}
        description: Self-hosted file sync and share
        icon: mdi-folder-sync
```

## How to apply changes

- If you changed `services.template.yaml` or other files under `apps/homepage/config`:
  - Rebuild Homepage image (from repo root):
  - `npm run vps:rebuild`
- If you changed only env values in `deploy/vps/services/homepage/.env`:
  - Restarting Homepage is enough.

## Troubleshooting

- Check generated config inside container:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps exec homepage sh -c "cat /app/config/services.yaml"`
- Check generator logs:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps logs homepage --tail 200`
- Common issue:
  - Missing env var removes tile silently by design.

## Official website

- https://gethomepage.dev/
