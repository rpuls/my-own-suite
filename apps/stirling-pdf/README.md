# Stirling PDF MOS Package

## Environment Variables

- `SERVER_HOST`: Projected from the app public URL.
- `SYSTEM_ENABLEANALYTICS=false`: Disables Stirling PDF's own analytics; the web client needs a patch as well (see Privacy Controls).

## Volumes And Persistence

- `configs:/configs`: Server configuration.
- `custom-files:/customFiles`: Custom assets.
- `logs:/logs`: Application logs.
- `pipeline:/pipeline`: Saved automation pipelines.
- `training-data:/usr/share/tessdata`: OCR language data.

Disable preserves these volumes so the app can be started again. Uninstall removes the app containers, routes, Suite Manager state, and these Docker volumes so the package returns to a clean installable state.

## Setup

No user inputs are required; the package installs with an empty setup form.

## Health Check

- `http://stirling-pdf:8080/api/v1/info/status`

## Privacy Controls

MOS sets `SYSTEM_ENABLEANALYTICS=false`, the upstream-supported system-wide control for disabling Stirling PDF analytics and suppressing its analytics consent prompt. It does not reach two things the web client starts on every page: PostHog, initialised at load with `api_host: "https://eu.i.posthog.com"`, and Stripe's `@stripe/stripe-js`, which injects `https://js.stripe.com/basil/stripe.js` on import.

`patch-web-client.py` runs at build time and rewrites those two hosts in `static/assets/*.js` inside `/app/app.jar` to `/mos-blocked/posthog` and `/mos-blocked/stripe`, so the requests go to Stirling PDF's own server and fail there. The build stops unless each host occurs exactly once, so a new upstream version cannot bring them back unnoticed. Side effect: the in-app licence purchase, which uses Stripe, no longer works. Icons the interface fetches from `api.iconify.design` are left alone.

User-invoked features such as trusted timestamping can still contact an external service.
