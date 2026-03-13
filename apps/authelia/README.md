#### Environment variables

- `DOMAIN`: Shared root domain used for protected routes and the Authelia portal.
- `MOS_AUTHELIA_PUBLIC_URL`: Public portal URL. Defaults to `https://auth.<domain>`.
- `MOS_AUTHELIA_THEME`: Portal theme. Supported values are `light`, `dark`, `grey`, `oled`, and `auto`. Defaults to `auto`.
- `MOS_AUTHELIA_SESSION_DOMAIN`: Shared cookie domain for protected subdomains. In this project it should match `DOMAIN`.
- `MOS_AUTHELIA_OWNER_EMAIL`: Initial owner email allowed to sign in.
- `MOS_AUTHELIA_OWNER_PASSWORD`: Initial owner password. The container hashes it at startup before writing the file backend config.
- `MOS_AUTHELIA_OWNER_DISPLAY_NAME`: Optional display name for the initial owner. Defaults to `Suite Owner`.
- `MOS_AUTHELIA_SESSION_SECRET`: Secret used to sign session data.
- `MOS_AUTHELIA_STORAGE_ENCRYPTION_KEY`: Encryption key for local storage data.
- `MOS_AUTHELIA_JWT_SECRET`: Secret used for identity-validation JWTs.
- `MOS_AUTHELIA_DATA_DIR`: Optional persistent data path. Defaults to `/data`.

#### Volumes and persistence

- Persist `/data` to keep the SQLite storage database and notification file.
- `/config` is generated at container start from environment variables and does not need its own volume in this project.

#### Protected routes in this project

- `https://homepage.<domain>`
- `https://suite-manager.<domain>`
- `https://auth.<domain>` serves the Authelia login portal.

#### Customizations in this project

- Generates `configuration.yml` and `users_database.yml` at container start so Railway and Docker Compose can drive the initial owner account entirely from env vars.
- Uses Authelia's file backend plus SQLite storage to keep the first deployment lightweight.
- Intentionally protects only Homepage and Suite Manager in the first pass. App-native auth remains in the underlying apps.
