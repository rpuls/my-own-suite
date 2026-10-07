import { useState } from 'react';

import { Notice, Panel, PanelBody, PanelHead, PanelItem, PanelList, Switch, useTechnicalControls } from '../../components/ui';

// The one place the technical-controls preference is written, and the only way
// an owner discovers the mode exists — nothing hints at it from the app pages,
// because a standing hint on every screen is the clutter this preference
// removes. The hook rather than a panel here because the control *is* the
// preference; it obviously cannot gate itself on being enabled.
export function TechnicalControlsPanel() {
  const { enabled, setEnabled } = useTechnicalControls();
  const [error, setError] = useState('');

  return <Panel>
    <PanelHead heading="h3" title="Technical controls">
      <p>Everything MOS does works the same either way; this only changes what you can see. You can turn it off again at any time without losing anything.</p>
    </PanelHead>
    <PanelList><PanelItem>
      <Switch
        checked={enabled}
        description="Adds panels showing what MOS generated for your apps and system — package details, addresses, configuration and raw logs — plus manual overrides."
        label="Show technical controls"
        onChange={(event) => {
          setError('');
          void setEnabled(event.currentTarget.checked).catch((caught: unknown) => {
            setError(caught instanceof Error ? caught.message : 'Your preference could not be saved.');
          });
        }}
      />
    </PanelItem></PanelList>
    {error ? <PanelBody><Notice title="Your preference was not saved" variant="error"><p>{error}</p></Notice></PanelBody> : null}
  </Panel>;
}
