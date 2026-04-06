import type { SuiteManagerConfig } from '../../../config.ts';
import type { CurrentAction } from '../shared/types.ts';

export function buildImmichSteps(config: SuiteManagerConfig, immichReady: boolean): CurrentAction[] {
  return [
    {
      completion: {
        mode: 'manual',
        source: immichReady ? 'manual' : 'none',
      },
      dependsOn: ['import-suite-credentials'],
      groupId: 'applications',
      id: 'open-immich',
      sections: [
        {
          action: {
            href: config.appUrls.immich,
            kind: 'link',
            label: 'Open Immich',
          },
          id: 'open-immich-app',
          title: 'Open your photo library',
        },
        {
          description:
            'If Immich shows a first-run setup wizard, finish that setup inside Immich before moving on. This only needs to happen once.',
          id: 'finish-immich-wizard',
          title: 'Finish the Immich first-run setup if prompted',
        },
        {
          description:
            'Your phone app can be connected later, but if photos are your priority, this is the point where your new private timeline starts to become real.',
          id: 'finish-immich',
          title: 'Confirm photos are ready',
          action: {
            actionId: 'open-immich',
            kind: 'trigger',
            label: 'Photos are ready',
          },
        },
      ],
      summary:
        'If photos matter most to you, continue with Immich next. It gives you a private timeline, browser access, and a clear next step toward automatic mobile backup.',
      title: 'Photos',
    },
  ];
}
