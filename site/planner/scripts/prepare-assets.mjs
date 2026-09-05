#!/usr/bin/env node
// Stages every asset the planner needs but must not commit:
//
//  1. MOS brand assets — synced from branding/ (single source of truth), then
//     copied into public/brand/ so the dev server resolves the same absolute
//     /brand/... URLs the deployed site serves.
//  2. The Dashboard Icons SVG set — fetched from the exact upstream commit
//     pinned in icon-source.json via a sparse, blob-filtered git checkout.
//     Third-party brand artwork therefore never enters this repository and the
//     published planner serves it first-party, so visitors' browsers only ever
//     talk to myownsuite.org. icon-denylist.json entries are stripped here.
//  3. The MOS app catalog — generated from apps/*/manifest.json, the same
//     source of truth the site and Suite Manager use.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const plannerRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const siteRoot = path.resolve(plannerRoot, '..');
const repoRoot = path.resolve(siteRoot, '..');

const require = createRequire(import.meta.url);
const { syncBranding } = require(path.join(repoRoot, 'scripts', 'sync-branding.cjs'));

// Keep in sync with the icon ids referenced by initialRoadmap in
// src/lib/roadmap-model.ts — a starter graphic with silent icon holes would
// ship broken without this guard.
const STARTER_ICON_IDS = [
  'google-home',
  'home-assistant',
  'google-photos',
  'immich',
  'tp-link',
  'opnsense',
  'apple',
  'apple-light',
  'google-calendar',
  'radicale',
  'google-drive',
  'seafile',
  'google-docs',
  'google-sheets',
  'google-slides',
  'onlyoffice',
  'google',
  'vaultwarden',
  'google-chrome',
  'firefox',
];

function stageBrandAssets() {
  syncBranding();
  const source = path.join(siteRoot, 'public', 'brand');
  const destination = path.join(plannerRoot, 'public', 'brand');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
}

function stageDashboardIcons() {
  const { repository, commit } = JSON.parse(
    fs.readFileSync(path.join(plannerRoot, 'icon-source.json'), 'utf8'),
  );
  const denylistRaw = fs.readFileSync(path.join(plannerRoot, 'icon-denylist.json'), 'utf8');
  const denylist = new Set(JSON.parse(denylistRaw).icons.map(String));
  // The leading number versions the staged output format; bump it when this
  // function changes what it writes so existing checkouts restage.
  const stamp = `2:${commit}:${createHash('sha256').update(denylistRaw).digest('hex')}`;

  const destination = path.join(plannerRoot, 'public', 'dashboard-icons');
  const markerPath = path.join(destination, '.staged');
  if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8') === stamp) {
    return { commit, skipped: true };
  }

  const checkout = path.join(plannerRoot, '.cache', 'dashboard-icons', commit);
  const checkoutReady = fs.existsSync(path.join(checkout, 'metadata.json'));
  if (!checkoutReady) {
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.mkdirSync(checkout, { recursive: true });
    // A sparse, blob-filtered fetch of the pinned commit: content is addressed
    // by the commit hash itself, and only svg/ + metadata + license blobs are
    // downloaded (~50 MB) instead of the full multi-format repository.
    git(checkout, 'init', '--quiet');
    git(checkout, 'remote', 'add', 'origin', repository);
    git(checkout, 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit);
    git(checkout, 'sparse-checkout', 'set', '--no-cone', '/svg/', '/metadata.json', '/LICENSE');
    git(checkout, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', commit);
  }

  const metadata = JSON.parse(fs.readFileSync(path.join(checkout, 'metadata.json'), 'utf8'));
  const staged = {};
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.join(destination, 'svg'), { recursive: true });
  for (const [id, entry] of Object.entries(metadata)) {
    if (denylist.has(id) || entry?.base !== 'svg') continue;
    const svgSource = path.join(checkout, 'svg', `${id}.svg`);
    if (!fs.existsSync(svgSource)) continue;
    fs.copyFileSync(svgSource, path.join(destination, 'svg', `${id}.svg`));
    // Monochrome logos ship per-scheme variants (upstream `colors` maps canvas
    // scheme → icon id); stage the variant files too so the planner can swap
    // them when the canvas flips. Denylisting a variant id strips just it.
    const colors = {};
    for (const [scheme, variantId] of Object.entries(entry.colors ?? {})) {
      if (!['light', 'dark'].includes(scheme) || typeof variantId !== 'string') continue;
      if (variantId === id || denylist.has(variantId)) continue;
      const variantSource = path.join(checkout, 'svg', `${variantId}.svg`);
      if (!fs.existsSync(variantSource)) continue;
      fs.copyFileSync(variantSource, path.join(destination, 'svg', `${variantId}.svg`));
      colors[scheme] = variantId;
    }
    staged[id] = { base: 'svg', aliases: entry.aliases ?? [], categories: entry.categories ?? [] };
    if (Object.keys(colors).length) staged[id].colors = colors;
  }
  fs.writeFileSync(path.join(destination, 'metadata.json'), JSON.stringify(staged));
  fs.copyFileSync(path.join(checkout, 'LICENSE'), path.join(destination, 'LICENSE'));

  const stagedIds = new Set(Object.keys(staged));
  for (const entry of Object.values(staged))
    for (const variantId of Object.values(entry.colors ?? {})) stagedIds.add(variantId);
  const missing = STARTER_ICON_IDS.filter((id) => !stagedIds.has(id));
  if (missing.length) {
    throw new Error(
      `Starter roadmap icons missing from the staged Dashboard Icons set: ${missing.join(', ')}. ` +
        'Update initialRoadmap in src/lib/roadmap-model.ts or the pinned commit in icon-source.json.',
    );
  }

  fs.writeFileSync(markerPath, stamp);
  return { commit, count: Object.keys(staged).length, skipped: false };
}

function stageMosCatalog() {
  const appsRoot = path.join(repoRoot, 'apps');
  const iconsDestination = path.join(plannerRoot, 'public', 'mos-apps');
  fs.rmSync(iconsDestination, { recursive: true, force: true });
  fs.mkdirSync(iconsDestination, { recursive: true });

  const apps = fs
    .readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(appsRoot, entry.name, 'manifest.json'), 'utf8'));
      } catch {
        return [];
      }
      if (!manifest?.id || !manifest?.name) return [];
      const iconSource = path.join(appsRoot, entry.name, 'icon.png');
      const hasIcon = fs.existsSync(iconSource);
      if (hasIcon) fs.copyFileSync(iconSource, path.join(iconsDestination, `${manifest.id}.png`));
      return [
        {
          id: String(manifest.id),
          name: String(manifest.name),
          summary: String(manifest.summary ?? ''),
          category: String(manifest.category ?? ''),
          replaces: Array.isArray(manifest.catalog?.replaces) ? manifest.catalog.replaces.map(String) : [],
          hasIcon,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const generatedDir = path.join(plannerRoot, 'src', 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(path.join(generatedDir, 'mos-apps.json'), JSON.stringify(apps, null, 2));
  return apps.length;
}

stageBrandAssets();
const icons = stageDashboardIcons();
const appCount = stageMosCatalog();
process.stdout.write(
  `Planner assets staged: brand synced, ${appCount} MOS catalog apps, Dashboard Icons @ ${icons.commit.slice(0, 10)}${
    icons.skipped ? ' (already staged)' : ` (${icons.count} icons)`
  }.\n`,
);
