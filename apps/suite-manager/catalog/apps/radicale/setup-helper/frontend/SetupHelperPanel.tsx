import { useState } from 'react';

import { ValueField } from '../../../../../frontend/src/features/onboarding/shared/components/ValueField';
import type { CatalogSetupHelperResponse } from '../../../../../frontend/src/features/app-catalog/types';
import { DeviceGuide } from './DeviceGuide';
import {
  DeviceSelector,
  type RadicaleDevice,
} from './DeviceSelector';

export const setupHelperId = 'radicale-device-setup';

type SetupHelperPanelProps = {
  helper: CatalogSetupHelperResponse;
};

export function SetupHelperPanel({ helper }: SetupHelperPanelProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [radicaleDevice, setRadicaleDevice] = useState<RadicaleDevice | null>(null);

  async function copyValue(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    setCopiedField(value);
    window.setTimeout(() => {
      setCopiedField((current) => (current === value ? null : current));
    }, 1400);
  }

  return (
    <>
      <DeviceSelector onSelect={setRadicaleDevice} selectedDevice={radicaleDevice} />
      {radicaleDevice ? <DeviceGuide device={radicaleDevice} /> : null}
      <ValueField
        copied={copiedField === helper.fields.serverUrl}
        label="Server URL"
        onCopy={() => void copyValue(helper.fields.serverUrl)}
        qrAlt="QR code for the Radicale server URL"
        qrValue={helper.fields.serverUrl}
        value={helper.fields.serverUrl}
      />
      <ValueField
        copied={copiedField === helper.fields.username}
        label="Username"
        onCopy={() => void copyValue(helper.fields.username)}
        value={helper.fields.username}
      />
      {helper.fields.password ? (
        <ValueField
          copied={copiedField === helper.fields.password}
          label="Password"
          onCopy={() => void copyValue(helper.fields.password || '')}
          value={helper.fields.password}
        />
      ) : null}
    </>
  );
}
