import type { SuiteManagerConfig } from '../../../config.ts';
import type { CurrentAction } from '../shared/types.ts';

function field(label: string, value: string, secret = false) {
  return {
    label,
    secret,
    value,
  };
}

export function buildSeafileSteps(config: SuiteManagerConfig, seafileReady: boolean): CurrentAction[] {
  const seafileAccount = config.generatedAccounts.seafile;

  return [
    {
      completion: {
        mode: 'manual',
        source: seafileReady ? 'manual' : 'none',
      },
      dependsOn: ['import-suite-credentials'],
      groupId: 'applications',
      id: 'open-seafile',
      sections: [
        {
          action: {
            href: config.appUrls.seafile,
            kind: 'link',
            label: 'Open Seafile',
          },
          id: 'open-seafile-app',
          title: 'Open your private drive',
        },
        ...(seafileAccount
          ? [
              {
                field: field('Email', seafileAccount.email),
                id: 'copy-seafile-email',
                title: 'Use your Seafile email',
              },
            ]
          : []),
        {
          description:
            'Use Vaultwarden autofill if you installed the browser extension. Otherwise open your Seafile item in Vaultwarden and copy the password from there.',
          id: 'use-seafile-credentials',
          title: 'Sign in with your imported Seafile credentials',
        },
        {
          description:
            'Once you are inside Seafile, you can upload a file now or come back later to set up desktop sync and browser-based document editing.',
          id: 'finish-seafile',
          title: 'Confirm files and office are ready',
          action: {
            actionId: 'open-seafile',
            kind: 'trigger',
            label: 'Files & Office are ready',
          },
        },
      ],
      summary:
        'Set up your private drive next if files matter most to you. Seafile becomes your everyday place for documents, uploads, sync, and browser-based editing with ONLYOFFICE.',
      title: 'Files & Office',
    },
  ];
}
