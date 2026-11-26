#### Environment variables

- `TZ`: Container timezone.
- `ALLOW_PRIVATE_IP_ADDRESS`: Allows document callbacks to private network addresses for self-hosted app integrations.
- `ALLOW_META_IP_ADDRESS`: Keeps metadata-address callbacks disabled.
- `METRICS_ENABLED`: Set to `false` so the Document Server's optional StatsD metrics emitter stays off (upstream default is also `false`).
- `PLUGINS_ENABLED`: Set to `false`. The upstream default `true` makes the image's start script run `documentserver-pluginsmanager.sh` at every start, which downloads the default plugin list from `onlyoffice.github.io` and the plugins from GitHub releases. The Community image carries only the marketplace plugin itself; the AI plugin below is the only one this package adds.
- `MOS_AI_BASE_URL`, `MOS_AI_API_KEY`, `MOS_AI_MODEL`: The AI service the owner turned on for ONLYOFFICE under **Settings → AI services**, from `${ai.*}`. Absent until then; see **AI Tools**.
- `JWT_ENABLED`: Enables JWT protection.
- `JWT_SECRET`: Stable provider-instance JWT secret shared with connected document platforms through MOS integration grants.
- `SECURE_LINK_SECRET`: Stable nginx secure-link secret for `/cache/files/...` URLs.

#### Volumes and persistence

- `data:/var/www/onlyoffice/Data`: ONLYOFFICE document server data and runtime state.

#### Dependencies and integrations

- Provides the `document-editor` capability using the ONLYOFFICE Docs API protocol.
- Normal use requires a compatible document platform, such as Seafile, to create, open, and save files.

#### Customizations in this package

- Startup wrapper normalizes selected environment values.
- Synchronizes nginx `secure_link_secret` with `SECURE_LINK_SECRET`.
- Prepares admin-panel supervisor log directories expected by current ONLYOFFICE images.
- Removes the Google Fonts stylesheet link from the welcome pages under `/var/www/onlyoffice/documentserver-example/welcome/`, so they render in the system font.
- Builds ONLYOFFICE's AI plugin into the image and lets the entrypoint switch it on and off; see **AI Tools**.

#### AI Tools

The Dockerfile downloads the AI plugin's packed release 3.0.8 at build time from `sdkjs-plugins/content/ai/deploy/ai.plugin` in ONLYOFFICE/onlyoffice.github.io, pinned to commit `689547aa716cf83c5696253852373f3d12d19d9d`, and fails the build unless its sha256 is `80712e63511b48524cb8ae3783cc31fd3ef21b7fa4e76723d5438a365f00ea5f`. That is the release current when 9.3.1 shipped. Do not move it on its own: 9.3.1 sends its server settings as version 3, and later plugin releases (3.2.2 checked) store version 4 and discard version 3 settings, so the editor would fall back to asking each user for a provider. Move it together with the Document Server pin, to the plugin release current at that version.

At every start, `configure_ai` in `entrypoint.sh` first deletes `aiSettings` from `/etc/onlyoffice/documentserver/local.json` and removes the plugin from `sdkjs-plugins/ai`. When `MOS_AI_BASE_URL` and `MOS_AI_MODEL` are set, it copies the plugin back and writes one provider, *My Own Suite*, with that model on the Chat, Summarization, Translation and Text analysis actions. Server-side settings are how ONLYOFFICE's Community edition configures AI for every user; its Admin Panel is a commercial feature. The editor sends each request to the Document Server's `/ai-proxy`, which relays only to URLs that start with the provider address and adds the key itself, so the key never reaches a browser and the request skips the private-address filter, which applies to document fetches. With no service turned on, the editor shows no AI Tools tab at all.
