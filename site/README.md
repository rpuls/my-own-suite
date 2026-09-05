# MOS Public Site

Astro + Starlight source for the MOS `myownsuite.org` website. The landing page and end-user documentation are implemented here and share the generated app catalog and canonical branding.

The visual design comes from the "My Own Suite Design System" project on claude.ai/design (`ui_kits/marketing/index.html`). That project is the design source of truth; shared brand tokens and utilities flow through the canonical branding workflow (`branding/styles/mos.css` → `npm run branding:sync` → `generated/branding/mos.css`), never through hand-edited copies. Only page-specific layout lives in `src/styles/landing.css`.

## App catalog is manifest-driven

The "Explore the apps" section is generated at build time from `apps/*/manifest.json` and `apps/*/icon.png` — the same single source of truth Suite Manager uses. Adding a new app package to the repo adds it to the landing page on the next build; no site change needed. The card/side-panel content uses `name`, `summary`, `category`, and the `catalog` fields (`description`, `replaces`, `resourceHint.label`, `privacy`, `features`, `links`, `demoDeployTargets`, `tags`).

## Digital Independence Planner

`planner/` is a standalone Vite + React sub-app deployed at `/plan/` — a free, browser-only roadmap builder that exports "digital independence journey" graphics. `npm run build` in `site/` builds it into `site/dist/plan` after the Astro build. It deliberately keeps its own toolchain (Tailwind, Base UI) so its styles never fight Starlight's; the brand look comes from the same synced `mos.css`.

Its `prebuild`/`predev` step (`planner/scripts/prepare-assets.mjs`) stages everything that must not live in git:

- Big Tech brand icons are fetched from the exact upstream [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) commit pinned in `planner/icon-source.json` and served first-party, so no third-party artwork is committed and visitors' browsers only talk to this site. `planner/icon-denylist.json` removes individual logos on request; affected nodes degrade to text labels.
- The "On My Own Suite" replacement suggestions are generated from `apps/*/manifest.json`, so new catalog apps appear automatically.

```bash
cd site/planner
npm install
npm run dev   # stages assets, then serves the planner alone at http://127.0.0.1:5173/
npm test      # layout engine + share-link tests
```

The editor stores plans in `localStorage` only, and share links carry the whole plan compressed in the URL fragment — there is no backend.

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

## Deployment

This folder is the deployed public site. `.github/workflows/deploy-site.yml` builds it on GitHub and deploys `site/dist` to Cloudflare Pages by direct upload — from `main` (production) and `staging` (aliased preview) only; no other branch deploys. The workflow needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, and the Pages project must not have its own git-integration builds enabled, so the Actions workflow stays the only deployment path.

Root `npm run build` and `wrangler.toml` (`site/dist`) point here as well.
