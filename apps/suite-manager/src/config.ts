import path from 'node:path';

export type SuiteManagerConfig = {
  appUrls: {
    homepage: string;
    immich: string;
    radicale: string;
    seafile: string;
    suiteManager: string;
    stirlingPdf: string;
    vaultwarden: string;
  };
  bootstrapToken: string;
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
  ownerEmail: string;
  ownerName: string;
  port: number;
  requestTimeoutMs: number;
  runOnce: boolean;
  stateDir: string;
  urlScheme: string;
  vaultwardenDatabaseUrl: string;
};

function buildPublicUrl(subdomain: string, urlScheme: string, domain: string): string {
  return `${urlScheme}://${subdomain}.${domain}`;
}

export function loadConfig(): SuiteManagerConfig {
  const port = Number(process.env.PORT) || 3000;
  const checkIntervalMs = Number(process.env.SUITE_MANAGER_CHECK_INTERVAL_MS) || 5 * 60 * 1000;
  const homepageUrl = process.env.HOMEPAGE_URL || 'http://homepage:3000/';
  const requestTimeoutMs = Number(process.env.SUITE_MANAGER_REQUEST_TIMEOUT_MS) || 10_000;
  const runOnce = process.env.SUITE_MANAGER_RUN_ONCE === 'true';
  const ownerEmail = process.env.OWNER_EMAIL || 'admin@myownsuite.local';
  const ownerName = process.env.OWNER_NAME || 'Owner';
  const bootstrapToken = (process.env.BOOTSTRAP_TOKEN || '').trim();
  const stateDir = process.env.SUITE_MANAGER_STATE_DIR || path.join(process.cwd(), '.suite-manager');
  const urlScheme = process.env.PUBLIC_URL_SCHEME || 'http';
  const domain = process.env.DOMAIN || 'localhost';
  const vaultwardenDatabaseUrl = (process.env.VAULTWARDEN_DATABASE_URL || process.env.DATABASE_URL || '').trim();
  const seafileAdminEmail = (process.env.SEAFILE_ADMIN_EMAIL || '').trim();
  const seafileAdminPassword = (process.env.SEAFILE_ADMIN_PASSWORD || '').trim();
  const radicaleAdminUsername = (process.env.RADICALE_ADMIN_USERNAME || '').trim();
  const radicaleAdminPassword = (process.env.RADICALE_ADMIN_PASSWORD || '').trim();

  return {
    appUrls: {
      homepage: process.env.HOMEPAGE_PUBLIC_URL || buildPublicUrl('homepage', urlScheme, domain),
      immich: process.env.IMMICH_PUBLIC_URL || buildPublicUrl('immich', urlScheme, domain),
      radicale: process.env.RADICALE_PUBLIC_URL || buildPublicUrl('radicale', urlScheme, domain),
      seafile: process.env.SEAFILE_PUBLIC_URL || buildPublicUrl('seafile', urlScheme, domain),
      suiteManager: process.env.SUITE_MANAGER_PUBLIC_URL || buildPublicUrl('suite-manager', urlScheme, domain),
      stirlingPdf: process.env.STIRLING_PDF_PUBLIC_URL || buildPublicUrl('stirling-pdf', urlScheme, domain),
      vaultwarden: process.env.VAULTWARDEN_PUBLIC_URL || buildPublicUrl('vaultwarden', 'https', domain),
    },
    bootstrapToken,
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
    ownerEmail,
    ownerName,
    port,
    requestTimeoutMs,
    runOnce,
    stateDir,
    urlScheme,
    vaultwardenDatabaseUrl,
  };
}
