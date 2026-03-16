#### Environment variables

- `HOMEPAGE_ALLOWED_HOSTS`: Allowed hostnames for Homepage (`hostname1,hostname2,...`).
- `SUITE_MANAGER_URL`: Public Suite Manager setup URL used for the Suite Manager resource tile.
- Any `${VAR_NAME}` used in `config/services.template.yaml`:
  - Example: `${SEAFILE_URL}`, `${VAULTWARDEN_URL}`, `${ONLYOFFICE_URL}`.
  - If not set (or empty), dependent tile is excluded from final dashboard.

#### Customizations in this project

- Homepage config is generated at container start from a template.
- `entrypoint.sh` runs `node /app/config-generator/dist/index.js /app/config` before starting Homepage.
- Suite Manager is the public login and setup surface for the stack; after sign-in it proxies Homepage instead of Homepage implementing its own login UI.
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
- `apps/homepage/config/custom.js`: first-run theme bootstrapping for Homepage's client-side UI.

Current defaults in this repo:
- `settings.yaml` keeps Homepage's built-in theme and palette switchers available, while `custom.js` nudges first-run users onto the bundled `theme-mos` palette.
- `custom.css` gives Homepage the same MOS brand feel used elsewhere in the suite, including the lighter clean-header treatment and softer card styling.
- `widgets.yaml` keeps the top bar intentionally simple with datetime and Startpage-powered search.
- The Suite Manager resource opens the control-plane `/setup/` route directly so users can return to onboarding later without guessing the URL.

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
  - Rebuild Homepage non-destructively: `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps up -d --build homepage`
- If you changed only env values in `deploy/vps/services/homepage/.env`:
  - Restarting Homepage is enough.

#### Troubleshooting

- Check generated config inside container:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps exec homepage sh -c "cat /app/config/services.yaml"`
- Check generator logs:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps logs homepage --tail 200`
- Common issue:
  - Missing env var removes tile silently by design.



