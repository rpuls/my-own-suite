# My Own Suite Site

This folder contains the Astro + Starlight website for `myownsuite.org`.

## Local development

```bash
cd site
npm i
npm run dev
```

## Build and preview

```bash
npm run build
npm run preview
```

## App screenshots

App screenshots for the public docs live under `site/src/assets/screenshots/<app>/` and are registered in `site/src/data/app-screenshots.ts`.

Keep this simple:

- Screenshots are served from the static site build, so prefer 1080p-class exports for reasonable load speed.
- Use 16:9 screenshots by default for consistency, unless the image is intentionally showing a mobile view.
- Save files under `site/src/assets/screenshots/<app>/` with long, descriptive, SEO-friendly names.
- Register them in `site/src/data/app-screenshots.ts` with clear `alt`, `title`, and `caption` text.
- Reuse `AppScreenshotGallery` on the app MDX page and run `npm run build` to verify the result.

## Cloudflare Pages

Use these settings:

- Build command: `npm run build`
- Output directory: `dist`
- Node version: `20` (recommended)


