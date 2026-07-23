#### Environment variables

- `TZ`: Container timezone.
- `ALLOW_PRIVATE_IP_ADDRESS`: Allows document callbacks to private network addresses for self-hosted app integrations.
- `ALLOW_META_IP_ADDRESS`: Keeps metadata-address callbacks disabled.
- `METRICS_ENABLED`: Set to `false` so the Document Server's optional StatsD metrics emitter stays off (upstream default is also `false`).
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
