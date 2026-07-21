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

Do not hand-edit generated copies when the change is shared branding.

## Frosted overlays

Use the shared frost tokens for translucent overlay UI so content behind the layer is softened instead of competing with foreground text and controls.

- Use `.mos-frost-backdrop` for full-screen scrims behind drawers, dialogs, and side panels.
- Use `.mos-frost` for translucent floating controls and lightweight panels.
- Use `.mos-frost-strong` for drawers, dialogs, popovers, and other elevated overlay surfaces.
- Prefer these shared classes or their `--mos-frost-*` tokens over one-off `backdrop-filter` values in app CSS.
