declare global {
  interface Window {
    __MOS_SUITE_MANAGER_SETUP_BASE_PATH__?: string;
  }
}

export function getSetupBasePath(): string {
  const value = window.__MOS_SUITE_MANAGER_SETUP_BASE_PATH__;
  if (!value) {
    return '/setup';
  }

  return value.replace(/\/+$/, '') || '/setup';
}

export function withSetupPath(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getSetupBasePath()}${normalizedPath}`;
}

