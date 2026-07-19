# MOS2 Public Site

Astro + Starlight source for the MOS `myownsuite.org` website. The landing page and end-user documentation are implemented here and share the generated app catalog and canonical branding.

The visual design comes from the "My Own Suite Design System" project on claude.ai/design (`ui_kits/marketing/index.html`). That project is the design source of truth; shared brand tokens and utilities flow through the canonical branding workflow (`branding/styles/mos.css` → `npm run branding:sync` → `generated/branding/mos.css`), never through hand-edited copies. Only page-specific layout lives in `src/styles/landing.css`.

## App catalog is manifest-driven

The "Explore the apps" section is generated at build time from `apps/*/manifest.json` and `apps/*/icon.png` — the same single source of truth Suite Manager uses. Adding a new app package to the repo adds it to the landing page on the next build; no site change needed. The card/side-panel content uses `name`, `summary`, `category`, and the `catalog` fields (`description`, `replaces`, `complexity.label`, `resourceHint.label`, `privacy`, `features`, `links`, `tags`).

## Local development

```bash
cd site
npm install
npm run dev
```

## Build and preview

```bash
cd site
npm run build
npm run preview
```

`predev`/`prebuild` run the branding sync automatically.

## Deployment status

Not deployed yet. The live site still builds from `site-mos1-reference/` (root `npm run build`, `wrangler.toml`). Switching Cloudflare Pages to this folder is a deliberate cutover step, tracked separately.
