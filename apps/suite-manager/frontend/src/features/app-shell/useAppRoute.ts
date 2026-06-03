import { useEffect, useState } from 'react';

import { getSetupBasePath, withSetupPath } from '../../lib/base-path';

export type AppRoute =
  | 'backups'
  | 'homepage'
  | 'homepage-config'
  | 'not-found'
  | 'onboarding'
  | 'updates';
export type NavigableAppRoute = '/' | '/backups' | '/customize' | '/onboarding' | '/updates';

function getRouteFromPathname(pathname: string): AppRoute {
  const basePath = getSetupBasePath();
  const relativePath = pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : pathname;

  if (relativePath === '') {
    return 'homepage';
  }

  if (pathname === '/' || pathname === '') {
    return 'homepage';
  }

  if (relativePath === '/' || relativePath === '/onboarding') {
    return 'onboarding';
  }

  if (relativePath === '/updates') {
    return 'updates';
  }

  if (relativePath === '/backups') {
    return 'backups';
  }

  if (relativePath === '/customize') {
    return 'homepage-config';
  }

  return 'not-found';
}

export function useAppRoute() {
  const [route, setRoute] = useState<AppRoute>(() => getRouteFromPathname(window.location.pathname));

  useEffect(() => {
    function handlePopState(): void {
      setRoute(getRouteFromPathname(window.location.pathname));
    }

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  function navigate(path: NavigableAppRoute): void {
    const nextUrl = path === '/' ? '/' : withSetupPath(path);
    window.history.pushState({}, '', nextUrl);
    setRoute(getRouteFromPathname(window.location.pathname));
  }

  return {
    navigate,
    route,
  };
}
