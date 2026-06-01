#### Environment variables

- `HOMEPAGE_ALLOWED_HOSTS`: Allowed hostnames for Homepage (`hostname1,hostname2,...`).
- `HOMEPAGE_CONFIG_SYNC_URL`: Suite Manager config export URL fetched during startup before `services.yaml` is generated.
- `HOMEPAGE_CONFIG_SYNC_TOKEN`: Shared private token sent as a bearer token when fetching Suite Manager-owned config.
- `HOMEPAGE_CONFIG_SYNC_ATTEMPTS`: Optional fetch retry count. Defaults to `12`.
- `HOMEPAGE_CONFIG_SYNC_RETRY_SECONDS`: Optional delay between fetch retries. Defaults to `2`.
- `HOMEPAGE_RESET_TO_DEFAULT`: Optional local fallback reset switch. Set to `1` or `true` for one startup to copy bundled defaults into Homepage's ephemeral local config before the Suite Manager fetch runs.
- `SUITE_MANAGER_URL`: Public Suite Manager base URL used for the Suite Manager resource tile, which appends `/setup/`.
- Any `${VAR_NAME}` used in the runtime `services.template.yaml`:
  - Example: `${SEAFILE_URL}`, `${VAULTWARDEN_URL}`, `${ONLYOFFICE_URL}`.
  - If not set (or empty), dependent tile is excluded from final dashboard.

#### Customizations in this project

- Homepage keeps repo defaults and runtime edits separate.
- Repo defaults are copied into the image at `/app/default-config` and are seed material only.
- Runtime editable config is owned by Suite Manager and fetched into `/app/config` during Homepage startup.
- If Suite Manager config cannot be fetched, `entrypoint.sh` falls back to bundled defaults in `/app/default-config`.
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
- `services.template.yaml`: categories, tile order, names, descriptions, and icons.
- `widgets.yaml`: widgets.
- `bookmarks.yaml`: bookmarks.
- `settings.yaml`: general dashboard settings.
- `custom.css`: visual overrides layered on top of Homepage defaults.
- `custom.js`: client-side theme bootstrapping that keeps Homepage on the bundled `theme-mos` palette unless a different theme is explicitly active.
- `docker.yaml`: Docker integration settings expected by Homepage.
- `kubernetes.yaml`: Kubernetes integration settings expected by Homepage.

Do not edit `/app/config/services.yaml` directly. It is generated from the runtime `services.template.yaml` at startup and may be replaced whenever Homepage restarts.
Suite Manager's authenticated Customize screen edits the persisted source files. Homepage fetches those files during startup and regenerates `services.yaml` before the stock Homepage server starts.

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

Optional MOS proxy annotation example:

```yaml
- My External Services:
    - Home Assistant:
        href: https://homeassistant.home.example.com
        description: Smart home control
        icon: home-assistant
        mos:
          kind: external
          proxy:
            enabled: true
            upstream: http://192.168.30.4:8123
            tls:
              insecureSkipVerify: false
```

For preview-only external proxy support, `href` is the dashboard URL and the generated Caddy host is inferred from its hostname. `mos.proxy.upstream` is the internal absolute `http` or `https` URL Caddy would reverse proxy to. `mos.proxy.tls.insecureSkipVerify` is optional and only affects HTTPS upstreams. Raw Caddy directives/snippets are not accepted in annotations.

Suite Manager exposes the parsed preview on `/setup/api/homepage-config/caddy-preview`. `GET` previews the saved `services.template.yaml`, and `POST` with `{ "content": "..." }` previews supplied editor content. Preview requests do not write Caddy config, reload Caddy, restart Caddy, or change Homepage output. Applying generated routes requires the host service agent and uses the saved `services.template.yaml`, not unsaved editor content.

#### Operational commands

- If you changed config in Suite Manager or env values in `deploy/vps/services/homepage/.env`:
  - Restarting Homepage is enough for the fetched config and generated `services.yaml` to refresh.
- If you changed repo defaults under `apps/homepage/config`:
  - Rebuild Homepage image (from repo root): `npm run vps:rebuild`
- To reset persisted runtime config to the bundled defaults:
  - Use Suite Manager's Customize screen reset action for the file you want to restore, then restart Homepage.

#### Troubleshooting

- Check generated config inside container:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps exec homepage sh -c "cat /app/config/services.yaml"`
- Check runtime template inside container:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps exec homepage sh -c "cat /app/config/services.template.yaml"`
- Check generator logs:
  - `docker compose -f deploy/vps/docker-compose.yml --project-directory deploy/vps logs homepage --tail 200`
- Common issue:
  - Missing env var removes tile silently by design.
