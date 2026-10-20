// The files screen's words and requests; the screen names a drive and a path
// from its top. Only what is inside MOS-files can be changed.

import { jsonResponse, postJson } from '../../lib/api';
import { formatBytes } from '../../lib/bytes';
import type { StorageEntry } from '../storage/model';

export type AppState = 'elsewhere' | 'not-installed' | null;

export type FileEntry = {
  appName: string | null;
  // In the apps folder, an app folder whose app does not read this drive.
  appState: AppState;
  bytes: number | null;
  items: number | null;
  kind: 'file' | 'folder';
  // Why this entry stays where it is, or null when it can be renamed, moved and deleted.
  locked: string | null;
  // Inside MOS-files, or one of MOS's own folders at the top of the drive.
  managed: boolean;
  modifiedAt: string;
  name: string;
  special: 'backups' | null;
};

export type FilesListing = {
  addRefusal: string | null;
  app: { id: string; name: string; readsDrive: boolean; state: AppState } | null;
  drive: { availableBytes: number | null; id: string; name: string; state: string; writable: boolean };
  entries: FileEntry[];
  managed: boolean;
  path: string;
  segments: string[];
  totals: { bytes: number | null; items: number };
};

export type Destination = { label: string; path: string };

const FILES_ROUTE = /^\/suite-manager\/storage\/([^/]+)\/files\/?$/u;

export function filesLocation() {
  const match = FILES_ROUTE.exec(window.location.pathname);
  return match ? { driveId: decodeURIComponent(match[1]!), path: new URLSearchParams(window.location.search).get('path') || '' } : null;
}

export function filesHref(driveId: string, path = '') {
  return `/suite-manager/storage/${encodeURIComponent(driveId)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`;
}

export function isFilesPath(pathname: string) {
  return FILES_ROUTE.test(pathname);
}

// A folder is a page of its own, so Back goes up a folder.
export function openFiles(driveId: string, path = '', { replace = false } = {}) {
  window.history[replace ? 'replaceState' : 'pushState']({}, '', filesHref(driveId, path));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function api(driveId: string, suffix = '') {
  return `/suite-manager/api/storage/drives/${encodeURIComponent(driveId)}/files${suffix}`;
}

export function downloadHref(driveId: string, path: string) {
  return `${api(driveId, '/download')}?path=${encodeURIComponent(path)}`;
}

// Null when the folder is gone, as an uninstalled app's folder is once emptied.
export async function listFiles(driveId: string, path: string) {
  const response = await fetch(`${api(driveId)}?path=${encodeURIComponent(path)}`);
  if (response.status === 404 && path) return null;
  return jsonResponse<FilesListing>(response, 'The files on this drive could not be listed.');
}

export async function listDestinations(driveId: string) {
  return (await jsonResponse<{ destinations: Destination[] }>(await fetch(api(driveId, '/destinations')), 'The folders on this drive could not be listed.')).destinations;
}

export const createFolder = (driveId: string, path: string, name: string) => postJson<{ path: string }>(api(driveId, '/folder'), { name, path }, 'The folder was not made.');
export const renameEntry = (driveId: string, path: string, name: string) => postJson<{ path: string }>(api(driveId, '/rename'), { name, path }, 'It was not renamed.');
export const moveEntries = (driveId: string, paths: string[], to: string) => postJson<{ moved: number }>(api(driveId, '/move'), { paths, to }, 'Nothing was moved.');
export const deleteEntries = (driveId: string, paths: string[]) => postJson<{ deleted: number }>(api(driveId, '/delete'), { confirmed: true, paths }, 'Nothing was deleted.');

export function uploadsApi(driveId: string) {
  return {
    begin: (body: { lastModified: number; name: string; path: string; size: number }) => fetch(api(driveId, '/uploads'), { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, method: 'POST' }),
    cancel: (uploadId: string) => fetch(api(driveId, `/uploads/${uploadId}/cancel`), { method: 'POST' }),
    chunkUrl: (uploadId: string, offset: number) => `${api(driveId, `/uploads/${uploadId}`)}?offset=${offset}`,
    finish: (uploadId: string) => fetch(api(driveId, `/uploads/${uploadId}/finish`), { method: 'POST' }),
  };
}

export const BACKUPS_PATH = '/suite-manager/backups';

export function openBackups(event: { preventDefault: () => void }) {
  event.preventDefault();
  window.history.pushState({}, '', BACKUPS_PATH);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function appStateLabel(state: AppState) {
  return state === 'elsewhere' ? 'Uses another drive' : 'Not installed';
}

export function joinPath(segments: string[], name?: string) {
  return [...segments, ...(name ? [name] : [])].join('/');
}

// Why Browse files is not offered for a drive right now, or '' when it is.
export function browseReason(entry: StorageEntry) {
  if (entry.capabilities.browsable) return '';
  switch (entry.state) {
    case 'away': return 'Plug the drive in to browse its files.';
    case 'ejected': return entry.connected ? 'Use the drive again to browse its files.' : 'Plug the drive back in to browse its files.';
    default: return entry.reason || 'MOS could not open this drive.';
  }
}

export function itemsLabel(count: number) {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

export function filesLabel(count: number) {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

export function entryFacts(entry: FileEntry) {
  if (entry.kind === 'folder') return [itemsLabel(entry.items ?? 0), entry.bytes !== null ? formatBytes(entry.bytes) : ''].filter(Boolean).join(' · ');
  const date = new Date(entry.modifiedAt);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `${formatBytes(entry.bytes)} · ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}`;
}

export function sizeOf(entries: FileEntry[]) {
  return entries.some((entry) => entry.bytes === null) ? null : entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
}
