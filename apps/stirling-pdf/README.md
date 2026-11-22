# Stirling PDF MOS Package

## Environment Variables

- `SERVER_HOST`: Projected from the app public URL.
- `SYSTEM_ENABLEANALYTICS=false`, `SYSTEM_ENABLEPOSTHOG=false`, `SYSTEM_ENABLESCARF=false`: Turn off Stirling PDF's analytics and its consent prompt (see Privacy Controls).
- `SYSTEM_ENABLEFEEDBACK=false`: Removes the feedback button, which links to a form on stirling.com.
- `SYSTEM_SHOWUPDATE=false`: Stops the startup check for a newer Stirling PDF and its popup; MOS delivers updates.
- `SYSTEM_SETUPCOMPLETED=true`: Skips the 3.x first-run setup wizard. Its settings (web address, email, SSO, AI) are features MOS does not ship, and it ends by asking the owner to restart the container. First sign-in stays the published default `admin` / `stirling` followed by a forced password change.

Environment values override `configs/settings.yml` at runtime, so changing these in Stirling PDF's own admin settings has no effect.

## Volumes And Persistence

- `configs:/configs`: Server configuration, the H2 database (users and stored-file records) and `credential-encryption.key`.
- `custom-files:/customFiles`: Custom assets.
- `logs:/logs`: Application logs.
- `pipeline:/pipeline`: Saved automation pipelines.
- `storage:/storage`: Files users save to or share from the server (3.x turns server storage on; added in package 0.3.0).
- `training-data:/usr/share/tessdata`: OCR language data.

`configs` and `storage` belong together: a stored file needs both its record in the database and its bytes in `storage`.

Disable preserves these volumes so the app can be started again. Uninstall removes the app containers, routes, Suite Manager state, and these Docker volumes so the package returns to a clean installable state.

## Setup

No user inputs are required; the package installs with an empty setup form.

## Health Check

- `http://stirling-pdf:8080/api/v1/info/status`

## Privacy Controls

From 3.x the web client loads PostHog only when analytics is on, and Stripe's `@stripe/stripe-js` only on its billing screen, so the settings above keep both off. `patch-web-client.py` stays as a backstop: at build time it rewrites PostHog's host (`https://eu.i.posthog.com`) and Stripe's script host (`https://js.stripe.com`) in `static/assets/*.js` inside `/app/app.jar` to `/mos-blocked/posthog` and `/mos-blocked/stripe`, so those requests would go to Stirling PDF's own server and fail. The build stops unless each host occurs exactly once. Side effect: the in-app licence purchase does not work.

Opening **Settings → General** in the web client asks `supabase.stirling.com` whether a newer version exists. No setting turns this off; it is listed in the privacy review.

User-invoked features such as trusted timestamping, or linking the server to a Stirling account, still contact an external service.
