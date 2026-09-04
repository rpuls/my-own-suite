// Response arranging for marketing screenshots.
//
// Some screens the public site wants a picture of describe a state the capture
// lab is never in. The Hyper-V VM tracks `staging` while the app catalog is read
// from `main`, so `staging` leads and no installed app is ever behind its
// catalog entry — the app update review dialog has therefore never been
// captured. The same VM follows a branch track, so the platform Updates screen
// reads "Staging branch" and a commit hash rather than the stable-release
// numbers a normal install shows.
//
// Neither is fixed in the product. AGENTS.md forbids test-only code paths, and a
// fixture flag in Suite Manager would mean the screenshots depict a build the
// owner never runs. Instead Playwright intercepts the response on its way to the
// browser, fetches the real one, and rewrites a small set of values in it. The
// UI, the components, the styling, and the response shape are all genuine; only
// which release the machine happens to be on is arranged.
//
// Three rules keep that from sliding:
//
// 1. Every stub starts from the live response (`route.fetch()`), never from a
//    hand-written payload. A hand-written fixture drifts from the API and the
//    screenshot silently starts showing a state the product can no longer
//    produce.
// 2. `STUBBABLE_PATHS` is an enforced allow-list, not a convention. Every field
//    a transform changed is diffed against it and an unlisted path throws.
// 3. A transform whose input is missing what it needs throws rather than
//    returning a half-arranged object, so a broken stub loses the screenshot
//    instead of publishing a wrong one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// What a screenshot may arrange, and nothing else.
//
// Every entry is a version number, an update-availability flag, a track
// identity, or the changelog summary that follows from them. All of it is
// ephemeral state a real machine passes through on an ordinary Tuesday, so
// arranging it depicts MOS honestly — the same standard as a product demo.
//
// What is deliberately absent matters more than what is here. Privacy posture,
// review status, permission diffs, structural change lists, package digests,
// compatibility verdicts, app counts, and catalog freshness are never
// stubbable. A marketing screenshot asserts those as facts about MOS, and a
// picture of a fact MOS did not produce is a false claim however the pixels got
// there. Adding a path to this list is a decision to make that claim; make it
// deliberately or not at all.
export const STUBBABLE_PATHS = {
  'apps/packages': [
    'packages[].catalogUpdate.status',
    'packages[].catalogUpdate.available.packageVersion',
  ],
  'apps/packages/:id/prepare-update': [
    'comparison.updateStatus',
    'comparison.candidate.packageVersion',
  ],
  'updates/status': [
    'track.type',
    'track.label',
    'track.ref',
    'track.currentBranch',
    'installedVersion',
    'latestRelease.version',
    'updateAvailable',
    'changeSummary.items',
    'changeSummary.source',
    'changeSummary.title',
  ],
};

// Mirrors `extractChangelogSection` in system-agents/update/lib.cjs: the heading
// form, the stop condition, the bullet form, and the six-item cap are the update
// agent's, so a stable-track summary built here is the one that agent would
// produce for the same release. A unit test pins the two together.
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\]/u;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Leaf-wise diff of two JSON values as dotted paths, with array indices
// collapsed to `[]` so the allow-list names fields rather than rows.
export function changedPaths(before, after, prefix = '') {
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [`${prefix}[]`];
    return before.flatMap((item, index) => changedPaths(item, after[index], `${prefix}[]`));
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? [] : [prefix];
}

// Runs one transform and refuses its result if it touched anything the
// allow-list does not name. The check runs on the way out rather than being
// trusted to the transform, so a future edit cannot widen what a screenshot
// fakes without editing STUBBABLE_PATHS too.
export function applyStub(endpoint, body, transform) {
  const allowed = STUBBABLE_PATHS[endpoint];
  if (!allowed) throw new Error(`${endpoint} is not a stubbable endpoint. Add it to STUBBABLE_PATHS with a reason, or do not stub it.`);
  const next = transform(body);
  // A listed field also covers replacing the contents of that field when it
  // holds a list, which `changedPaths` reports with a trailing `[]`.
  const forbidden = changedPaths(body, next).filter((changed) => !allowed.some((path) => changed === path || changed === `${path}[]`));
  if (forbidden.length) {
    throw new Error(`Stubbing ${endpoint} changed fields that are not stubbable: ${forbidden.join(', ')}. Screenshots may arrange version and update state, never claims MOS makes about itself.`);
  }
  return next;
}

// Released sections of a CHANGELOG, newest first, with the bullets the update
// agent would show for each.
export function changelogReleases(changelog) {
  const releases = [];
  let current = null;
  for (const raw of String(changelog).split(/\r?\n/u)) {
    const line = raw.trim();
    const heading = RELEASE_HEADING.exec(line);
    if (heading) {
      current = { items: [], version: heading[1] };
      releases.push(current);
    } else if (line.startsWith('## ')) current = null;
    else if (current && line.startsWith('- ')) current.items.push(line.slice(2).trim());
  }
  return releases.map((release) => ({ items: release.items.slice(0, 6), version: release.version }));
}

export function readRepoChangelog() {
  return fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
}

// The version an update would move an app to. Minor bump, patch zeroed, which is
// what an app package release usually looks like.
export function nextPackageVersion(version) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(version || '').trim());
  if (!parsed) throw new Error(`Cannot arrange a newer version from "${version}": it is not a plain semantic version.`);
  return `${parsed[1]}.${Number(parsed[2]) + 1}.0`;
}

// Puts one installed app one release behind its catalog entry, so the detail
// view offers "Review update". Everything else about the package — its digest,
// its minimum MOS version, its source revision, its privacy summary — is the
// catalog's own.
export function stubPackagesUpdateAvailable(body, { availableVersion, packageId }) {
  if (!Array.isArray(body?.packages)) throw new Error('The packages response has no packages array to arrange.');
  const target = body.packages.find((item) => item.id === packageId);
  if (!target) throw new Error(`${packageId} is not in the packages response, so there is nothing to arrange an update for.`);
  if (!target.instance) throw new Error(`${packageId} is not installed, so an available update would not render a review action.`);
  if (!target.catalogUpdate?.available) throw new Error(`${packageId} has no catalog candidate (catalogUpdate status: ${target.catalogUpdate?.status || 'null'}), so there is no real candidate to date forward.`);
  if (!target.catalogUpdate.installed?.packageVersion) throw new Error(`${packageId} reports no installed package version, so an update pair cannot be formed.`);
  return {
    ...body,
    packages: body.packages.map((item) => (item.id === packageId
      ? {
        ...item,
        catalogUpdate: {
          ...item.catalogUpdate,
          available: { ...item.catalogUpdate.available, packageVersion: availableVersion },
          status: 'update-available',
        },
      }
      : item)),
  };
}

// Dates the compared candidate forward so the review dialog opens on a real
// comparison of the real package pair. The change list, permission diff, privacy
// row, and update metadata are whatever the backend computed for that pair — for
// two identical packages that is honestly "no structural changes detected".
export function stubUpdateComparison(body, { availableVersion }) {
  const comparison = body?.comparison;
  if (!comparison) throw new Error('The prepare-update response carries no comparison to arrange.');
  if (!comparison.candidate || !comparison.installed?.packageVersion) throw new Error('The comparison is missing its installed/candidate pair, so there is no update to date forward.');
  if (!['current', 'installed-newer'].includes(comparison.updateStatus)) {
    throw new Error(`Expected a lab comparison with nothing to apply, got updateStatus "${comparison.updateStatus}". A real update is available — capture it without arranging.`);
  }
  return {
    ...body,
    comparison: {
      ...comparison,
      candidate: { ...comparison.candidate, packageVersion: availableVersion },
      updateStatus: 'update-available',
    },
  };
}

// Presents the lab's branch-tracking machine as a stable-track install sitting
// one release behind, which is the state an owner's machine is actually in when
// this screen matters. Both version numbers and every changelog bullet are read
// from the repository's real CHANGELOG.md, so the release notes on the
// screenshot are MOS's real release notes.
export function stubStableTrackStatus(body, { changelog }) {
  if (!body?.track) throw new Error('The update status response has no track to arrange.');
  if (!body.latestRelease) throw new Error('The update status response has no latestRelease to arrange.');
  if (!body.changeSummary) throw new Error('The update status response has no changeSummary to arrange.');
  const releases = changelogReleases(changelog);
  if (releases.length < 2) throw new Error(`CHANGELOG.md has ${releases.length} released section(s); a stable-track update needs a released version and the one before it.`);
  const [latest, previous] = releases;
  if (!latest.items.length) throw new Error(`CHANGELOG.md [${latest.version}] has no bullets, so the release-notes panel would render empty.`);
  return {
    ...body,
    changeSummary: { ...body.changeSummary, items: latest.items, source: `CHANGELOG.md [${latest.version}]`, title: `Changes in ${latest.version}` },
    installedVersion: previous.version,
    latestRelease: { ...body.latestRelease, version: latest.version },
    track: { ...body.track, currentBranch: null, label: 'Stable releases', ref: 'main', type: 'stable' },
    updateAvailable: true,
  };
}

// Installs the interceptors and hands back a handle that says whether the screen
// the capture is about to photograph is actually showing arranged state.
export async function stubApiForScreenshot(page, { label, routes }) {
  const applied = new Set();
  const failures = [];
  const installed = [];

  for (const route of routes) {
    const handler = async (interception) => {
      let response = null;
      try {
        // prepare-update genuinely downloads a candidate package, which is well
        // past the default route timeout on a cold catalog.
        response = await interception.fetch({ timeout: 120000 });
        const next = applyStub(route.endpoint, await response.json(), route.transform);
        applied.add(route.endpoint);
        console.log(`[screenshots] arranged ${route.endpoint} for ${label}`);
        await interception.fulfill({ body: JSON.stringify(next), contentType: 'application/json', response });
      } catch (error) {
        failures.push(`${route.endpoint}: ${error.message}`);
        if (response) await interception.fulfill({ response }).catch(() => undefined);
        else await interception.continue().catch(() => undefined);
      }
    };
    await page.route(route.predicate, handler);
    installed.push({ handler, predicate: route.predicate });
  }

  return {
    // Called after the screen has loaded and before the shutter: a transform
    // that threw, or a response that was never intercepted, means the browser is
    // showing something other than what this capture claims to show.
    assertArranged() {
      if (failures.length) throw new Error(`${label}: response arranging failed: ${failures.join('; ')}`);
      const missed = routes.map((route) => route.endpoint).filter((endpoint) => !applied.has(endpoint));
      if (missed.length) throw new Error(`${label}: never intercepted ${missed.join(', ')}, so this screen is not showing arranged state.`);
    },
    async dispose() {
      for (const entry of installed) await page.unroute(entry.predicate, entry.handler).catch(() => undefined);
    },
  };
}

export async function withStubbedApi(page, spec, run) {
  const stub = await stubApiForScreenshot(page, spec);
  try {
    return await run(stub);
  } finally {
    await stub.dispose();
  }
}

// Marks a capture in the run output so a reader can tell an arranged screenshot
// from one the lab produced on its own.
export function announceArrangedCapture(name, reason) {
  console.log(`[screenshots] ${name}.png was ARRANGED: real UI and real response shape, with ${reason}.`);
}

export function apiPathPredicate(pathname) {
  return (url) => url.pathname === pathname;
}
