# MOS1 Public Site (Preserved Reference)

This folder preserves the MOS1 Astro + Starlight website for `myownsuite.org`. It remains the deployed public site source until the MOS public site is rebuilt under `site/`, because the latest published release is still MOS1.

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
npm run build          # from the repo root (also used by Cloudflare Pages)
cd site-mos1-reference && npm run preview
```

## Cloudflare Pages

The root `wrangler.toml` points Pages at `site-mos1-reference/dist`. The expected setup is:

- Build command: `npm run build` (repo root)
- Output directory: `site-mos1-reference/dist` (from `wrangler.toml`)
- Node version: `22`
