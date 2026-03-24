# Branding

This folder is the single source of truth for My Own Suite branding.

Update these files here:

- `my-own-suite-mark.png`: canonical project mark
- `favicons/*`: canonical generated favicon assets
- `styles/mos.css`: canonical shared MOS brand stylesheet

Do not hand-edit the synced copies in app folders when the change is meant to affect shared MOS branding.

Current sync targets include:

- `site/src/generated/branding/mos.css`
- `apps/suite-manager/frontend/src/styles/mos.css`
- `apps/homepage/config/custom.css` for the generated Homepage theme block
- app-local `public/brand/*` and favicon files used at runtime

Then run:

```bash
npm run branding:sync
```

That script refreshes the app-local copies used by the Astro site and Suite Manager so each app stays self-contained at runtime without manual copy-paste maintenance.

Recommended workflow:

1. Edit canonical assets or tokens in `branding/`
2. Run `npm run branding:sync`
3. Rebuild or preview the affected apps
4. Do not commit manual edits to generated sync targets unless the sync script itself was intentionally changed
