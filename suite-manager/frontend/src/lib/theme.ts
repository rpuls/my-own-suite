import { useEffect, useState } from 'react';

export type ThemePreference = 'auto' | 'dark' | 'light';

const STORAGE_KEY = 'mos-theme';
const CHANGE_EVENT = 'mos-theme-change';
const LIGHT_QUERY = '(prefers-color-scheme: light)';
const THEME_COLOR = { dark: '#061526', light: '#f4f8fd' };

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

function applyThemePreference(preference: ThemePreference) {
  const theme = preference === 'auto' ? (window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark') : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

export function writeThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'auto') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // The theme still applies for this page load when storage is blocked.
  }
  applyThemePreference(preference);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribeToThemeChanges(onChange: () => void) {
  const media = window.matchMedia(LIGHT_QUERY);
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) onChange(); };
  media.addEventListener('change', onChange);
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    media.removeEventListener('change', onChange);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function startThemeFollowing() {
  const sync = () => applyThemePreference(readThemePreference());
  sync();
  return subscribeToThemeChanges(sync);
}

export function useThemePreference() {
  const [preference, setPreference] = useState(readThemePreference);
  useEffect(() => subscribeToThemeChanges(() => setPreference(readThemePreference())), []);
  return { preference, setPreference: writeThemePreference };
}
