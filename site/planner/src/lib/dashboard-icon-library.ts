import { svgTextToDataUrl } from '@/lib/icon-library';
import type { IconRef } from '@/lib/roadmap-model';

interface DashboardIconMetadata {
  base?: string;
  aliases?: string[];
  categories?: string[];
  colors?: IconSchemeVariants;
}

// Per-canvas-scheme icon ids for monochrome logos (e.g. apple on a light
// canvas, apple-light on a dark one), as staged from upstream metadata.
export interface IconSchemeVariants {
  light?: string;
  dark?: string;
}

export interface DashboardIcon {
  id: string;
  name: string;
  aliases: string[];
  categories: string[];
  searchText: string;
  colors?: IconSchemeVariants;
}

const FEATURED = [
  'google-chrome',
  'firefox',
  'google-drive',
  'nextcloud',
  'google-photos',
  'immich',
  'google-calendar',
  'home-assistant',
  'apple',
  'microsoft',
  'office-365',
  'onlyoffice',
  'dropbox',
  'seafile',
  'bitwarden',
  'vaultwarden',
  'github',
  'gitlab',
];

let catalogPromise: Promise<DashboardIcon[]> | undefined;

// Icons are staged by scripts/prepare-assets.mjs and served first-party from
// this deployment; the browser never contacts a third-party host for them.
const iconsBase = `${import.meta.env.BASE_URL}dashboard-icons`;

export function dashboardIconUrl(id: string) {
  return `${iconsBase}/svg/${encodeURIComponent(id)}.svg`;
}

export function loadDashboardIcons(): Promise<DashboardIcon[]> {
  catalogPromise ??= fetch(`${iconsBase}/metadata.json`)
    .then((response) => {
      if (!response.ok)
        throw new Error('The local icon catalog could not be opened.');
      return response.json() as Promise<Record<string, DashboardIconMetadata>>;
    })
    .then((metadata) => {
      const icons = Object.entries(metadata)
        .filter(([, value]) => value.base === 'svg')
        .map(([id, value]) => {
          const name = displayName(id);
          const aliases = Array.isArray(value.aliases) ? value.aliases : [];
          const categories = Array.isArray(value.categories)
            ? value.categories
            : [];
          return {
            id,
            name,
            aliases,
            categories,
            colors: value.colors,
            searchText: [id, name, ...aliases, ...categories]
              .join(' ')
              .toLowerCase(),
          };
        });
      const featuredOrder = new Map(FEATURED.map((id, index) => [id, index]));
      return icons.sort((a, b) => {
        const aRank = featuredOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bRank = featuredOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return aRank - bRank || a.name.localeCompare(b.name);
      });
    });
  return catalogPromise;
}

// Maps every id of a variant pair (base, light and dark ids alike) to the
// full pair, so an icon can be re-pointed when the canvas scheme flips.
export async function loadIconVariantIndex(): Promise<
  Map<string, { light: string; dark: string }>
> {
  const icons = await loadDashboardIcons();
  const index = new Map<string, { light: string; dark: string }>();
  for (const icon of icons) {
    if (!icon.colors) continue;
    const pair = {
      light: icon.colors.light ?? icon.id,
      dark: icon.colors.dark ?? icon.id,
    };
    for (const id of [icon.id, pair.light, pair.dark]) index.set(id, pair);
  }
  return index;
}

export function iconIdForScheme(
  variants: Map<string, { light: string; dark: string }> | null,
  id: string,
  scheme: 'light' | 'dark',
) {
  return variants?.get(id)?.[scheme] ?? id;
}

export async function createDashboardIcon(
  icon: Pick<DashboardIcon, 'id' | 'name'>,
): Promise<IconRef> {
  const response = await fetch(dashboardIconUrl(icon.id));
  if (!response.ok)
    throw new Error(
      `${icon.name} could not be loaded from the local icon catalog.`,
    );
  return {
    id: icon.id,
    name: icon.name,
    source: 'dashboard',
    dataUrl: svgTextToDataUrl(await response.text(), `dashboard-${icon.id}`),
    attribution: `Dashboard Icons: ${icon.id}`,
  };
}

export function displayName(id: string) {
  const acronyms: Record<string, string> = {
    ai: 'AI',
    api: 'API',
    aws: 'AWS',
    dns: 'DNS',
    nas: 'NAS',
    vpn: 'VPN',
  };
  return id
    .split(/[-_]/)
    .map(
      (part) =>
        acronyms[part] ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
    )
    .join(' ');
}
