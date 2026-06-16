import type { ComponentType } from 'react';

import type { CatalogSetupHelperResponse } from './types';

type CatalogSetupHelperPanelProps = {
  helper: CatalogSetupHelperResponse;
};

type CatalogSetupHelperModule = {
  setupHelperId: string;
  SetupHelperPanel?: ComponentType<CatalogSetupHelperPanelProps>;
};

const setupHelperModules = import.meta.glob<CatalogSetupHelperModule>(
  '../../../../catalog/apps/*/setup-helper/frontend/SetupHelperPanel.tsx',
  { eager: true },
);

const setupHelperPanels = new Map<string, ComponentType<CatalogSetupHelperPanelProps>>();

for (const setupHelperModule of Object.values(setupHelperModules)) {
  const Panel = setupHelperModule.SetupHelperPanel;
  if (setupHelperModule.setupHelperId && Panel) {
    setupHelperPanels.set(setupHelperModule.setupHelperId, Panel);
  }
}

export function CatalogSetupHelperPanel({ helper }: CatalogSetupHelperPanelProps) {
  const Panel = setupHelperPanels.get(helper.id);
  if (!Panel) {
    return null;
  }

  return <Panel helper={helper} />;
}
