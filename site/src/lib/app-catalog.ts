// Build-time app catalog shared by the landing page and the docs app
// pages. Everything is generated from each package's manifest under
// apps/<app>/manifest.json — the same single source of truth Suite
// Manager uses — so adding a new app package to the repo adds it to the
// site automatically on the next build.

import type { PrivacyAdvisory, PrivacyReviewSummary } from './privacy-posture'

export type CatalogFeature = { title: string; body: string }
export type CatalogApp = {
  id: string
  name: string
  version: string
  category: string
  categorySlug: string
  summary: string
  description: string
  replaces: string
  setup: string
  setupDetail: string
  resources: string
  resourcesDetail: string
  privacy: string
  privacyNotes: string[]
  privacyReview: PrivacyReviewSummary
  advisories: PrivacyAdvisory[]
  features: CatalogFeature[]
  links: Record<string, string>
  tags: string[]
  icon: string
}

const manifestModules = import.meta.glob('../../../apps/*/manifest.json', {
  eager: true,
  import: 'default'
}) as Record<string, any>
const iconModules = import.meta.glob('../../../apps/*/icon.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>
// README embeds for the docs app pages: each module exposes an Astro
// <Content /> component that renders the package's technical reference.
const readmeModules = import.meta.glob('../../../apps/*/README.md', {
  eager: true
}) as Record<string, any>
// Structured privacy assessments (privacy-review.json) for the posture
// badge/dialog. The site shows the current repo package's review — the same
// candidate a fresh install would get. Apps without a review render the
// truthful "Review required / not yet rated" state.
const privacyReviewModules = import.meta.glob('../../../apps/*/privacy-review.json', {
  eager: true,
  import: 'default'
}) as Record<string, any>

const UNRATED: PrivacyReviewSummary = {
  dimensions: null,
  posture: 'review-required',
  provenance: null,
  reviewedAt: null,
  status: 'review-required'
}

// Light presentation check only (id + version binding). Full validation of
// the review binding happens in Suite Manager at install/update time.
function privacyReviewFor(manifestPath: string, manifest: any): PrivacyReviewSummary {
  const review = privacyReviewModules[manifestPath.replace(/manifest\.json$/, 'privacy-review.json')]
  if (
    !review ||
    review.schemaVersion !== 1 ||
    review.appId !== manifest.id ||
    review.scope?.packageVersion !== manifest.version
  ) {
    return UNRATED
  }
  const provenance = review.provenance ?? {}
  return {
    dimensions: review.dimensions ?? null,
    posture: String(review.posture ?? 'review-required'),
    provenance: {
      humanReviewed: provenance.humanReviewed === true,
      method: provenance.method ?? null,
      model: provenance.model ?? null,
      sourceRevision: review.scope?.source?.revision ?? null
    },
    reviewedAt: review.reviewedAt ?? null,
    status: 'reviewed'
  }
}

// The official advisory feed (apps/advisories.json) is authored, source-trusted
// metadata about published package versions. The site shows advisories that
// apply to the current repo package version — the same candidate a fresh
// install would get — kept separate from the installed assessment.
const advisoryIndex = import.meta.glob('../../../apps/advisories.json', {
  eager: true,
  import: 'default'
}) as Record<string, any>
const allAdvisories: PrivacyAdvisory[] = (
  Object.values(advisoryIndex)[0]?.advisories ?? []
) as PrivacyAdvisory[]

function semverParts(value: string): number[] | null {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}
function compareSemver(left: string, right: string): number | null {
  const a = semverParts(left)
  const b = semverParts(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return Math.sign(a[i] - b[i])
  return 0
}
function advisoryAppliesToVersion(range: string, version: string): boolean {
  const trimmed = String(range).trim()
  if (trimmed === '*') return semverParts(version) !== null
  if (/^\d+\.\d+\.\d+/.test(trimmed)) return compareSemver(version, trimmed) === 0
  const comparators = trimmed.split(/\s+/).filter(Boolean)
  if (!comparators.length) return false
  return comparators.every((comparator) => {
    const match = comparator.match(/^(<=|>=|<|>)(.+)$/)
    if (!match) return false
    const comparison = compareSemver(version, match[2])
    if (comparison === null) return false
    return match[1] === '<' ? comparison < 0
      : match[1] === '<=' ? comparison <= 0
        : match[1] === '>' ? comparison > 0
          : comparison >= 0
  })
}
function advisoriesFor(manifest: any): PrivacyAdvisory[] {
  return allAdvisories.filter(
    (advisory) => advisory.packageId === manifest.id && advisoryAppliesToVersion(advisory.affectedVersions, manifest.version)
  )
}

// Friendly labels for manifest category slugs; unknown slugs fall back
// to a capitalized form so new categories never break the site.
const CATEGORY_LABELS: Record<string, string> = {
  media: 'Photos & media',
  office: 'Office & documents',
  security: 'Passwords & security',
  storage: 'Files & sync'
}
export const categoryLabel = (slug: string) =>
  CATEGORY_LABELS[slug] ?? (slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'App')

export const LINK_LABELS: Record<string, string> = {
  website: 'Official website',
  docs: 'App documentation',
  repository: 'Source code'
}

export const catalogApps: CatalogApp[] = Object.entries(manifestModules)
  .map(([path, manifest]) => {
    const catalog = manifest.catalog ?? {}
    const features: CatalogFeature[] = (Array.isArray(catalog.features) ? catalog.features : [])
      .map((feature: unknown) =>
        typeof feature === 'string'
          ? { title: feature, body: '' }
          : { title: String((feature as any)?.title ?? ''), body: String((feature as any)?.body ?? '') }
      )
      .filter((feature: CatalogFeature) => feature.title)
    return {
      id: String(manifest.id ?? ''),
      name: String(manifest.name ?? ''),
      version: String(manifest.version ?? ''),
      category: categoryLabel(String(manifest.category ?? '')),
      categorySlug: String(manifest.category ?? ''),
      summary: String(manifest.summary ?? ''),
      description: String(catalog.description ?? manifest.summary ?? ''),
      replaces: String(catalog.replaces ?? ''),
      setup: String(catalog.complexity?.label ?? ''),
      setupDetail: String(catalog.complexity?.description ?? ''),
      resources: String(catalog.resourceHint?.label ?? ''),
      resourcesDetail: String(catalog.resourceHint?.description ?? ''),
      privacy: String(catalog.privacy?.summary ?? ''),
      privacyNotes: Array.isArray(catalog.privacy?.notes) ? catalog.privacy.notes.map(String) : [],
      privacyReview: privacyReviewFor(path, manifest),
      advisories: advisoriesFor(manifest),
      features,
      links: catalog.links && typeof catalog.links === 'object' ? catalog.links : {},
      tags: Array.isArray(catalog.tags) ? catalog.tags.map(String) : [],
      icon: iconModules[path.replace(/manifest\.json$/, 'icon.png')] ?? ''
    }
  })
  .filter((app) => app.id && app.name)
  .sort((a, b) => a.name.localeCompare(b.name))

// Keyed by app id; components can't travel inside the JSON-serializable
// catalog objects above, so the README embeds live in their own map.
export const appReadmes: Record<string, any> = Object.fromEntries(
  Object.entries(readmeModules).flatMap(([path, mod]) => {
    const id = path.match(/apps[/\\]([^/\\]+)[/\\]README\.md$/)?.[1]
    return id ? [[id, mod]] : []
  })
)
