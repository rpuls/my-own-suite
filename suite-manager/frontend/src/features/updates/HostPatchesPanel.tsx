import { useState } from 'react';

import { AdvancedPanel, Checkbox, Dialog, Panel, PanelBand, PanelBody, PanelHead, Row, RowValue, Rows, Spinner } from '../../components/ui';

export type HostHealth = {
  at: string | null;
  failures: Array<{ active: string; name: string; sub: string }>;
  ok: boolean | null;
  reason: string | null;
};

export type HostPatches = {
  allowedOrigins: string[];
  automaticReboot: boolean | null;
  available: boolean;
  checkedAt: string | null;
  diagnostics: string | null;
  health: HostHealth | null;
  heldPackages: string[];
  lastInstallAt: string | null;
  lastInstalledPackages: string[];
  lastRunAt: string | null;
  managedBy: 'mos' | 'none' | 'owner' | 'unknown';
  managedReason: string | null;
  otherCount: number;
  rebootPackages: string[];
  rebootRequired: boolean;
  security: string[];
  securityCount: number;
  summary: string;
};

function waitingLabel(host: HostPatches) {
  if (!host.available) return 'Could not be read';
  return host.securityCount === 0 ? 'None' : `${host.securityCount}`;
}

function installedLabel(host: HostPatches, formatDate: (value: string | null) => string) {
  if (!host.available) return 'Could not be read';
  if (!host.lastInstallAt) return 'Nothing yet';
  const packages = host.lastInstalledPackages.length;
  return `${formatDate(host.lastInstallAt)} — ${packages === 1 ? '1 package' : `${packages} packages`}`;
}

// A restart is the one thing on this screen that interrupts everyone using the
// suite, so it is confirmed rather than clicked. The checkbox is the shared
// acknowledgement primitive: the same shape as every other "I know what this
// does" in Suite Manager.
function RestartDialog({ asksForPassword, onClose, onConfirm }: {
  asksForPassword: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" onClick={onClose} type="button">Not now</button>
      <button className="mos-btn mos-btn-primary" disabled={!confirmed} onClick={onConfirm} type="button">Restart the server</button>
    </>}
    onClose={onClose}
    title="Restart this server"
  >
    <p>A patch is installed but does not take effect until the server restarts. This is usually a kernel fix.</p>
    <p>Every app stops for a minute or two, and anything anyone is in the middle of — an upload, a sync, a document — is cut off. {asksForPassword
      ? 'This server is set to ask for your password before it opens your data, so your apps stay off until you open its address and type it.'
      : 'Everything comes back on its own once the server is up.'}</p>
    <Checkbox checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)}>
      I understand the suite will be offline for a few minutes.
    </Checkbox>
  </Dialog>;
}

// Ubuntu's own patch state, beside the MOS and app updates rather than on a
// screen of its own: an owner asking whether their server is current is asking
// one question, not three.
export function HostPatchesPanel({ asksForPassword, busy, formatDate, host, onRestart, restarting }: {
  asksForPassword: boolean;
  busy: string;
  formatDate: (value: string | null) => string;
  host: HostPatches;
  onRestart: () => void;
  restarting: boolean;
}) {
  const [asking, setAsking] = useState(false);
  // The same panel is a diagnostic on a server that is not taking patches and
  // ambient detail on one that is, which is why the reveal is computed.
  const troubled = !host.available || host.managedBy === 'none' || host.health?.ok === false;
  const facts = [
    { label: 'Security updates waiting', value: waitingLabel(host) },
    { label: 'Other updates available', value: String(host.otherCount) },
    { label: 'Automatic restart', value: host.automaticReboot === null ? 'Unknown' : host.automaticReboot ? 'On' : 'Off' },
    { code: true, label: 'Installs from', value: host.allowedOrigins.join(', ') || 'nothing' },
    ...host.heldPackages.length ? [{ code: true, label: 'Held back by MOS', value: host.heldPackages.join(', ') }] : [],
    { label: 'Package lists refreshed', value: formatDate(host.checkedAt) },
  ];

  return <>
    <Panel>
      <PanelHead title="Operating system">
        <p className="suite-meta">{host.summary}</p>
      </PanelHead>

      {host.rebootRequired ? <PanelBand
        icon="update"
        note={host.rebootPackages.length ? `asked for by ${host.rebootPackages.slice(0, 3).join(', ')}` : undefined}
        title="A restart is needed to finish"
        tone="warning"
      >
        <button className="mos-btn mos-btn-ghost mos-btn-sm" disabled={Boolean(busy) || restarting} onClick={() => setAsking(true)} type="button">
          Restart server
        </button>
      </PanelBand> : null}

      {host.managedBy === 'owner' ? <PanelBand
        icon="settings"
        note={host.managedReason || undefined}
        title="You manage Ubuntu updates on this server"
        tone="info"
      /> : null}

      {host.managedBy === 'none' ? <PanelBand
        icon="update"
        note={host.managedReason || 'MOS could not set this up on this server.'}
        title="Security updates are not being applied automatically"
        tone="warning"
      /> : null}

      {/* The check runs after every boot as well as after every patch, so it
          names both rather than blaming a patch for a service that is down for
          a reason of its own. The units and the time are the evidence. */}
      {host.health?.ok === false ? <PanelBand
        icon="update"
        note={[formatDate(host.health.at), ...host.health.failures.map((failure) => `${failure.name} is ${failure.active}`)].join(', ')}
        title="Not every MOS service came back after the last patch or restart"
        tone="warning"
      /> : null}

      <PanelBody>
        <Rows lead>
          <Row help="Ubuntu's own security fixes, installed on their own. MOS never moves you to a new Ubuntu release, and Docker and Caddy do not come from this channel." label="Waiting to install">
            <RowValue>{waitingLabel(host)}</RowValue>
          </Row>
          <Row label="Last checked">
            <RowValue>{!host.available ? 'Could not be read' : host.lastRunAt ? formatDate(host.lastRunAt) : 'Not yet'}</RowValue>
          </Row>
          <Row label="Last installed">
            <RowValue>{installedLabel(host, formatDate)}</RowValue>
          </Row>
          <Row label="Restart needed">
            <RowValue>{!host.available ? 'Unknown' : host.rebootRequired ? 'Yes' : 'No'}</RowValue>
          </Row>
          <AdvancedPanel
            facts={facts}
            layout="row"
            output={host.diagnostics || undefined}
            reveal={troubled ? 'on-failure' : 'technical-mode'}
            summary="Ubuntu patch details"
          />
        </Rows>
        {restarting ? <p className="suite-meta"><Spinner />Restarting. This page stops responding for a few minutes and comes back on its own.</p> : null}
      </PanelBody>
    </Panel>

    {asking ? <RestartDialog
      asksForPassword={asksForPassword}
      onClose={() => setAsking(false)}
      onConfirm={() => { setAsking(false); onRestart(); }}
    /> : null}
  </>;
}
