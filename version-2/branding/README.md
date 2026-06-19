# V2 Branding

This is the canonical V2 branding source.

Change shared colors, fonts, spacing, radii, and shared MOS CSS tokens here first. Then run:

```powershell
npm --prefix version-2 run branding:sync
```

Generated targets:

- `version-2/site/generated/branding/mos.css`
- `version-2/suite-manager/frontend/src/styles/mos.css`
- `version-2/infrastructure/homepage/custom.css` inside the sync marker block
- public brand assets under future site and Suite Manager folders

Do not hand-edit generated copies when the change is shared branding.
