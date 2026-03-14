import { useEffect, useState } from 'react';

import { getSetupBasePath, withSetupPath } from '../../lib/base-path';

export type AppRoute = 'homepage' | 'not-found' | 'onboarding';

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

  function navigate(path: '/' | '/onboarding'): void {
    const nextUrl = path === '/' ? '/' : withSetupPath(path);
    window.history.pushState({}, '', nextUrl);
    setRoute(getRouteFromPathname(window.location.pathname));
  }

  return {
    navigate,
    route,
  };
}
