# MOS1 Public Site (Preserved Reference)

This folder preserves the MOS1 Astro + Starlight website for `myownsuite.org`. It is no longer built in CI or deployed: the live site now builds from `site/` and deploys through `.github/workflows/deploy-site.yml`. This copy remains only as a frozen reference.

Content is frozen at the MOS1 cutover point:

- App and self-host technical reference content is embedded from `src/reference/`, which holds copies taken from the `archive/mos1-main-snapshot` branch. It intentionally does not read the live MOS `apps/` packages.
- Do not add new product documentation here. New end-user docs belong to the MOS rebuild in `site/`.
- Small factual fixes (broken links, typos, release notes) are fine.

## Local development

```bash
cd site-mos1-reference
npm install
npm run dev
```

## Build and preview

```bash
cd site-mos1-reference
npm install
npm run build
npm run preview
```
