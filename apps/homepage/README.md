#### Environment variables

- `HOMEPAGE_ALLOWED_HOSTS`: Allowed hostnames for Homepage (`hostname1,hostname2,...`).
- `HOMEPAGE_RESET_TO_DEFAULT`: Optional reset switch. Set to `1` or `true` for one startup to copy repo default config over the runtime config, then unset it again.
- `SUITE_MANAGER_URL`: Public Suite Manager base URL used for the Suite Manager resource tile, which appends `/setup/`.
- Any `${VAR_NAME}` used in the runtime `services.template.yaml`:
  - Example: `${SEAFILE_URL}`, `${VAULTWARDEN_URL}`, `${ONLYOFFICE_URL}`.
  - If not set (or empty), dependent tile is excluded from final dashboard.

#### Customizations in this project

- Homepage keeps repo defaults and runtime edits separate.
- Repo defaults are copied into the image at `/app/default-config` and are seed material only.
- Runtime editable config lives at `/app/config`, which is mounted as persistent storage in the VPS/local Compose stack.
- On first boot, `entrypoint.sh` copies missing default files into `/app/config` without overwriting existing user edits.
- On each startup, `entrypoint.sh` runs `node /app/config-generator/dist/index.js /app/config` before starting Homepage.
- Suite Manager is the public login and setup surface for the stack; after sign-in it proxies Homepage instead of Homepage implementing its own login UI.
- Default services template: `/app/default-config/services.template.yaml`
- Runtime services template: `/app/config/services.template.yaml`
- Generated output: `/app/config/services.yaml`
- Generator behavior:
  - Replaces `${ENV_VAR}` placeholders using runtime environment values.
  - If any placeholder in a service is unresolved, that full service is removed.
  - If a category has no remaining services, that category is removed.
  - Recursive nested groups remain supported.
- Result: tiles appear only when their required env values exist.

Runtime files commonly edited for customization:
- `/app/config/services.template.yaml`: categories, tile order, names, descriptions, and icons.
- `/app/config/widgets.yaml`: widgets.
- `/app/config/bookmarks.yaml`: bookmarks.
- `/app/config/settings.yaml`: general dashboard settings.
- `/app/config/custom.css`: visual overrides layered on top of Homepage defaults.
- `/app/config/custom.js`: client-side theme bootstrapping that keeps Homepage on the bundled `theme-mos` palette unless a different theme is explicitly active.
- `/app/config/docker.yaml`: Docker integration settings expected by Homepage.
- `/app/config/kubernetes.yaml`: Kubernetes integration settings expected by Homepage.

Do not edit `/app/config/services.yaml` directly. It is generated from the runtime `services.template.yaml` at startup and may be replaced whenever Homepage restarts.
When Suite Manager has the Homepage config volume mounted, its authenticated Customize screen edits the same runtime files and regenerates `services.yaml` after saving `services.template.yaml`.

Current defaults in this repo:
- `settings.yaml` keeps Homepage's built-in theme and palette switchers available, while `custom.js` keeps fallback/default clients on the bundled `theme-mos` palette.
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

- If you changed runtime files in `/app/config` or env values in `deploy/vps/services/homepage/.env`:
  - Restarting Homepage is enough.
- If you changed repo defaults under `apps/homepage/config`:
  - Rebuild Homepage image (from repo root): `npm run vps:rebuild`
- To reset runtime config to the repo defaults:
  - Start Homepage once with `HOMEPAGE_RESET_TO_DEFAULT=1`, then remove that variable before the next restart.

#### Troubleshooting

- Check generated config inside container:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps exec homepage sh -c "cat /app/config/services.yaml"`
- Check runtime template inside container:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps exec homepage sh -c "cat /app/config/services.template.yaml"`
- Check generator logs:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps logs homepage --tail 200`
- Common issue:
  - Missing env var removes tile silently by design.
