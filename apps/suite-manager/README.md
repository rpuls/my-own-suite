#### Environment variables

- `PORT`: HTTP port for the suite-manager status endpoint. Defaults to `3000`.
- `HOMEPAGE_URL`: Homepage URL to probe. Defaults to `http://homepage:3000/`.
- `SUITE_MANAGER_CHECK_INTERVAL_MS`: Homepage probe interval in milliseconds. Defaults to `300000`.
- `SUITE_MANAGER_REQUEST_TIMEOUT_MS`: Timeout per Homepage request in milliseconds. Defaults to `10000`.
- `SUITE_MANAGER_RUN_ONCE`: If set to `true`, performs one Homepage check and exits. Useful for smoke tests.

#### Health and behavior

- Exposes a simple HTTP `200` status endpoint on `/`.
- Logs a success line when Homepage returns a `2xx` response.
- Logs a failure line when Homepage returns a non-`2xx` response or the request errors.

#### Customizations in this project

- Designed as the future shared-control service for stack-wide config, checks, and bootstrap logic.
- Current scope is intentionally minimal so it can be used as a Railway service target immediately.
