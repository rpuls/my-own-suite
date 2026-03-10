import QRCode from 'qrcode';

import type { SuiteManagerConfig } from '../../../config.ts';
import { presentValue } from '../../../lib/secrets.ts';
import type { CurrentAction, OnboardingStep } from '../shared/types.ts';

function field(label: string, value: string, authorized: boolean, secret = false) {
  return {
    label,
    secret,
    value: presentValue(value, authorized, secret),
  };
}

function buildRadicaleCollectionUrl(config: SuiteManagerConfig): string {
  const username = config.generatedAccounts.radicale?.username || 'admin';
  return `${config.appUrls.radicale.replace(/\/$/, '')}/${encodeURIComponent(username)}/`;
}

function buildDavx5Url(config: SuiteManagerConfig): string {
  const username = config.generatedAccounts.radicale?.username || 'admin';
  const collectionUrl = buildRadicaleCollectionUrl(config);
  const url = new URL(collectionUrl);
  return `davx5://${encodeURIComponent(username)}@${url.host}${url.pathname}`;
}

async function buildDavx5QrCode(config: SuiteManagerConfig): Promise<string> {
  return QRCode.toDataURL(buildDavx5Url(config), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 220,
  });
}

export async function buildRadicaleSteps(
  config: SuiteManagerConfig,
  authorized: boolean,
  prerequisitesReady: boolean,
  radicaleConnected: boolean,
): Promise<OnboardingStep[]> {
  const collectionUrl = buildRadicaleCollectionUrl(config);
  const radicaleUsername = config.generatedAccounts.radicale?.username || 'admin';
  const qrCode = await buildDavx5QrCode(config);

  const connectCalendar: CurrentAction = {
    id: 'connect-radicale',
    sections: [
      {
        description:
          'If you use Android with DAVx5, scan this QR code. Some phones may open DAVx5 directly, while others will at least let you copy the setup link onto the phone more easily.',
        id: 'android-qr',
        qrCode: {
          alt: 'QR code for DAVx5 calendar setup',
          caption: 'Android + DAVx5',
          src: qrCode,
        },
        title: 'Scan on Android',
      },
      {
        description: 'If your device does not support the QR helper, use these details manually and take the password from the Radicale item you just imported into Vaultwarden.',
        field: field('Server URL', collectionUrl, authorized),
        id: 'manual-url',
        title: 'Manual setup',
      },
      {
        field: field('Username', radicaleUsername, authorized),
        id: 'manual-username',
        title: 'Use this username',
      },
      {
        description: 'The password is stored in Vaultwarden under the Radicale item you imported in the previous step.',
        id: 'manual-password',
        title: 'Use your imported Radicale password',
      },
      {
        action: {
          actionId: 'connect-radicale',
          kind: 'trigger',
          label: 'My calendar is connected',
        },
        id: 'finish-radicale',
        title: 'Finish this step after your calendar is connected',
      },
    ],
    summary:
      'Next, connect your devices to your new private calendar server. The setup steps can vary depending on which device you use, and we will guide you through the path that fits best. Your Radicale password is already in Vaultwarden from the previous step.',
    title: 'Step 3: Connect your calendar',
  };

  return [
    {
      ...connectCalendar,
      status: !prerequisitesReady ? 'locked' : radicaleConnected ? 'completed' : 'active',
    },
  ];
}
