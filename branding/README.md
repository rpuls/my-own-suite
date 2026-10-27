# MOS Branding

This is the canonical MOS branding source.

Change shared colors, fonts, spacing, radii, and shared MOS CSS tokens here first. Then run:

```powershell
npm run branding:sync
```

Generated targets:

- `site/generated/branding/mos.css`
- `suite-manager/frontend/src/styles/mos.css`
- `infrastructure/homepage/custom.css` inside the sync marker block
- public brand assets under future site and Suite Manager folders
- `infrastructure/homepage/images/my-own-suite-mark.png` for the local Homepage tile
- `branding/mos-wallpaper.svg` and app-local public copies of the shared wallpaper
- Navidrome's inline login wallpaper in `apps/navidrome/manifest.json`

Do not hand-edit generated copies when the change is shared branding.

## App wallpaper

`mos-wallpaper.template.svg` defines the shared dark wallpaper. The sync script fills it with the canonical logo and colors from `styles/mos.css`, then writes the self-contained `mos-wallpaper.svg`. The subdued mark sits below a centered sign-in form and remains visible when the image is cropped for a phone.

Apps can use the generated file locally or embed it as a data URL. Navidrome uses the latter, so its sign-in page needs no external image request. Updating an inline package target changes that app's package contents; refresh its package binding and catalog before publishing.

## Frosted overlays

Use the shared frost tokens for translucent overlay UI so content behind the layer is softened instead of competing with foreground text and controls.

- Use `.mos-frost-backdrop` for full-screen scrims behind drawers, dialogs, and side panels.
- Use `.mos-frost` for translucent floating controls and lightweight panels.
- Use `.mos-frost-strong` for drawers, dialogs, popovers, and other elevated overlay surfaces.
- Prefer these shared classes or their `--mos-frost-*` tokens over one-off `backdrop-filter` values in app CSS.
