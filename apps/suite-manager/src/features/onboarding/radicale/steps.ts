import type { SuiteManagerConfig } from '../../../config.ts';
import type { CurrentAction, OnboardingStep } from '../shared/types.ts';

function field(label: string, value: string, secret = false) {
  return {
    label,
    secret,
    value,
  };
}

function buildRadicaleCollectionUrl(config: SuiteManagerConfig): string {
  const username = config.generatedAccounts.radicale?.username || 'admin';
  return `${config.appUrls.radicale.replace(/\/$/, '')}/${encodeURIComponent(username)}/`;
}

export async function buildRadicaleSteps(
  config: SuiteManagerConfig,
  prerequisitesReady: boolean,
  radicaleConnected: boolean,
): Promise<OnboardingStep[]> {
  const collectionUrl = buildRadicaleCollectionUrl(config);
  const radicaleUsername = config.generatedAccounts.radicale?.username || 'admin';

  const connectCalendar: CurrentAction = {
    completion: {
      mode: 'manual',
      source: radicaleConnected ? 'manual' : 'none',
    },
    id: 'connect-radicale',
    sections: [
      {
        description:
          'Use this server address when you add your private calendar. If typing the full address on another device is annoying, you can copy it or show it as a QR code from this field.',
        field: {
          ...field('Server URL', collectionUrl),
          qrAlt: 'QR code for the Radicale server URL',
          qrValue: collectionUrl,
        },
        id: 'manual-url',
        title: 'Manual setup',
      },
      {
        field: field('Username', radicaleUsername),
        id: 'manual-username',
        title: 'Use this username',
      },
      {
        description:
          'The password is stored in Vaultwarden under the Radicale item you imported in the previous step.',
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
      'Next, connect one of your devices to your private calendar server. Choose the device you want to set up now, then follow the exact steps shown for that device. Your Radicale password is already in Vaultwarden from the previous step.',
    title: 'Step 3: Connect your calendar',
  };

  return [
    {
      ...connectCalendar,
      status: !prerequisitesReady ? 'locked' : radicaleConnected ? 'completed' : 'active',
    },
  ];
}
