import path from 'node:path';

export type SuiteManagerConfig = {
  appUrls: {
    immich: string;
    radicale: string;
    seafile: string;
    suiteManager: string;
    stirlingPdf: string;
    vaultwarden: string;
  };
  checkIntervalMs: number;
  generatedAccounts: {
    radicale: {
      password: string;
      username: string;
    } | null;
    seafile: {
      email: string;
      password: string;
    } | null;
  };
  domain: string;
  homepageUrl: string;
  ownerPassword: string;
  ownerEmail: string;
  ownerName: string;
  port: number;
  requestTimeoutMs: number;
  runOnce: boolean;
  sessionCookieName: string;
  sessionMaxAgeSeconds: number;
  sessionSecret: string;
  setupBasePath: string;
  stateDir: string;
  updates: {
    enabled: boolean;
    githubRepo: string;
    latestVersionOverride: string;
    mode: 'managed' | 'notify-only';
  };
  urlScheme: string;
  vaultwardenDatabaseUrl: string;
};

function buildPublicUrl(subdomain: string, urlScheme: string, domain: string): string {
  return `${urlScheme}://${subdomain}.${domain}`;
}

function normalizeSetupUrl(value: string, setupBasePath: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';

    if (normalizedPath === '/' || normalizedPath === '') {
      parsed.pathname = setupBasePath;
    }

    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function normalizeBasePath(value: string | undefined, fallback: string): string {
  const trimmed = (value || fallback).trim();
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash || fallback;
}

function requireEnv(name: string, fallback?: string): string {
  const value = (process.env[name] || fallback || '').trim();
  if (!value) {
    throw new Error(`${name} is required for suite-manager auth.`);
  }
  return value;
}

export function loadConfig(): SuiteManagerConfig {
  const port = Number(process.env.PORT) || 3000;
  const checkIntervalMs = Number(process.env.SUITE_MANAGER_CHECK_INTERVAL_MS) || 5 * 60 * 1000;
  const homepageUrl = process.env.HOMEPAGE_URL || 'http://homepage:3000/';
  const requestTimeoutMs = Number(process.env.SUITE_MANAGER_REQUEST_TIMEOUT_MS) || 10_000;
  const runOnce = process.env.SUITE_MANAGER_RUN_ONCE === 'true';
  const ownerEmail = requireEnv('OWNER_EMAIL', 'admin@myownsuite.local');
  const ownerName = process.env.OWNER_NAME || 'Owner';
  const ownerPassword = requireEnv('OWNER_PASSWORD');
  const sessionSecret = requireEnv('SESSION_SECRET');
  const stateDir = process.env.SUITE_MANAGER_STATE_DIR || path.join(process.cwd(), '.suite-manager');
  const urlScheme = process.env.PUBLIC_URL_SCHEME || 'http';
  const domain = process.env.DOMAIN || 'localhost';
  const setupBasePath = normalizeBasePath(process.env.SUITE_MANAGER_BASE_PATH, '/setup');
  const sessionCookieName = (process.env.SUITE_MANAGER_SESSION_COOKIE_NAME || 'mos-suite-manager-session').trim();
  const sessionMaxAgeSeconds = Number(process.env.SUITE_MANAGER_SESSION_MAX_AGE_SECONDS) || 60 * 60 * 24 * 14;
  const vaultwardenDatabaseUrl = (process.env.VAULTWARDEN_DATABASE_URL || process.env.DATABASE_URL || '').trim();
  const updatesEnabled = (process.env.SUITE_MANAGER_UPDATES_ENABLED || 'true').trim().toLowerCase() !== 'false';
  const updatesGithubRepo = (process.env.SUITE_MANAGER_GITHUB_REPO || 'rpuls/my-own-suite').trim();
  const updatesLatestVersionOverride = (process.env.SUITE_MANAGER_UPDATES_LATEST_VERSION_OVERRIDE || '').trim();
  const updatesMode =
    (process.env.SUITE_MANAGER_UPDATES_MODE || 'notify-only').trim().toLowerCase() === 'managed'
      ? 'managed'
      : 'notify-only';
  const seafileAdminEmail = (process.env.SEAFILE_ADMIN_EMAIL || '').trim();
  const seafileAdminPassword = (process.env.SEAFILE_ADMIN_PASSWORD || '').trim();
  const radicaleAdminUsername = (process.env.RADICALE_ADMIN_USERNAME || '').trim();
  const radicaleAdminPassword = (process.env.RADICALE_ADMIN_PASSWORD || '').trim();

  return {
    appUrls: {
      immich: process.env.IMMICH_PUBLIC_URL || buildPublicUrl('immich', urlScheme, domain),
      radicale: process.env.RADICALE_PUBLIC_URL || buildPublicUrl('radicale', urlScheme, domain),
      seafile: process.env.SEAFILE_PUBLIC_URL || buildPublicUrl('seafile', urlScheme, domain),
      suiteManager: normalizeSetupUrl(
        process.env.SUITE_MANAGER_PUBLIC_URL || buildPublicUrl('suite-manager', urlScheme, domain),
        setupBasePath,
      ),
      stirlingPdf: process.env.STIRLING_PDF_PUBLIC_URL || buildPublicUrl('stirling-pdf', urlScheme, domain),
      vaultwarden: process.env.VAULTWARDEN_PUBLIC_URL || buildPublicUrl('vaultwarden', 'https', domain),
    },
    checkIntervalMs,
    generatedAccounts: {
      radicale:
        radicaleAdminUsername && radicaleAdminPassword
          ? {
              password: radicaleAdminPassword,
              username: radicaleAdminUsername,
            }
          : null,
      seafile:
        seafileAdminEmail && seafileAdminPassword
          ? {
              email: seafileAdminEmail,
              password: seafileAdminPassword,
            }
          : null,
    },
    domain,
    homepageUrl,
    ownerPassword,
    ownerEmail,
    ownerName,
    port,
    requestTimeoutMs,
    runOnce,
    sessionCookieName,
    sessionMaxAgeSeconds,
    sessionSecret,
    setupBasePath,
    stateDir,
    updates: {
      enabled: updatesEnabled,
      githubRepo: updatesGithubRepo,
      latestVersionOverride: updatesLatestVersionOverride,
      mode: updatesMode,
    },
    urlScheme,
    vaultwardenDatabaseUrl,
  };
}
