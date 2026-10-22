// Moving between Suite Manager's pages from inside one: a pushState the shell
// hears as a popstate, so every screen navigates the one way the shell does.

export const BACKUPS_PATH = '/suite-manager/backups';
export const STORAGE_SETTINGS_PATH = '/suite-manager/settings#set-storage';

export function filesPath(driveId: string, path = '') {
  return `/suite-manager/storage/${encodeURIComponent(driveId)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`;
}

export function navigateTo(path: string, { replace = false } = {}) {
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// For a link whose href is the real path, so it still opens in a new tab.
export function navigateOnClick(path: string) {
  return (event: { preventDefault: () => void }) => {
    event.preventDefault();
    navigateTo(path);
  };
}

export const openStorageSettings = navigateOnClick(STORAGE_SETTINGS_PATH);
export const openBackups = navigateOnClick(BACKUPS_PATH);
