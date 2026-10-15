import type { ReactNode } from 'react';

import { AdvancedPanel, Notice, PanelBand } from '../../../components/ui';
import type { AddressChange, AddressStatus, AppReconciliationResult, Contact, LiveProgress, SuiteAddress, SuiteAddressController } from './model';

const CHANGE_STAGE_SENTENCES: Record<string, string> = {
  apps: 'Rebuilding your apps and Homepage on the new address.',
  caddy: 'Configuring the web server and waiting for the certificate. This can take a minute or two.',
  recorded: 'Recording the new address.',
};

const listOf = (names: string[]) => new Intl.ListFormat('en', { type: 'conjunction' }).format(names);

function appsSentence(apps: NonNullable<LiveProgress['apps']>) {
  if (!apps.total) return CHANGE_STAGE_SENTENCES.apps;
  if (!apps.current) return `All ${apps.total} apps are rebuilt. Joining connected apps again.`;
  const minutes = apps.remainingSeconds === null ? null : Math.max(1, Math.round(apps.remainingSeconds / 60));
  return `Rebuilding your apps on the new address, one at a time: ${apps.current} now, ${apps.done} of ${apps.total} done.${minutes === null ? '' : ` About ${minutes === 1 ? 'a minute' : `${minutes} minutes`} left.`}`;
}

// The current address, or the move in progress in its place with what it is
// doing right now.
export function AddressBand({ note, status, suite }: { note: string; status: AddressStatus; suite: SuiteAddressController }) {
  const change = status.lastChange;
  if (change.status !== 'applying') {
    return <PanelBand icon="check" note={note} title={<a href={status.address.url}>{status.address.url}</a>} tone="accent" />;
  }
  const target = change.target?.host || 'its new address';
  if (change.stage === 'dns') {
    return <PanelBand busy note={`${change.live.dns?.sentence || 'Looking up the domain.'} MOS checks again every few seconds for up to half an hour, and changes nothing until it points here.`} title={`Waiting for ${target} to point at this server`} tone="info">
      <button className="mos-btn mos-btn-ghost mos-btn-sm" disabled={Boolean(suite.busy)} onClick={() => void suite.cancelChange()} type="button">{suite.busy === 'cancel' ? 'Cancelling...' : 'Cancel'}</button>
    </PanelBand>;
  }
  const doing = change.stage === 'apps' && change.live.apps ? appsSentence(change.live.apps) : CHANGE_STAGE_SENTENCES[change.stage || ''] || 'Starting.';
  return <PanelBand busy note={`${doing}${suite.contact === 'unreachable' ? ' The web server is restarting, so this page has no answer for a moment. It keeps asking.' : ''}`} title={`Moving your suite to ${target}`} tone="info" />;
}

// Said before the owner moves: every installed app is rebuilt on the new address,
// one at a time, which on a full suite takes long enough to look broken.
export function RebuildNotice({ apps }: { apps: string[] }) {
  if (!apps.length) return null;
  const one = apps.length === 1;
  return <Notice title={one ? 'Your app restarts on the new address' : `Your ${apps.length} apps restart on the new address`} variant="info">
    <p>{listOf(apps)} {one ? 'is' : 'are'} rebuilt one at a time so {one ? 'it uses' : 'they use'} the new address, and each is briefly unavailable while it restarts. With many apps this takes several minutes; this page shows each one as it goes.</p>
  </Notice>;
}

export function ContactNotices({ change, contact }: { change: AddressChange | null; contact: Contact }) {
  return <>
    {contact === 'signed-out' ? <Notice title="Your session ended" variant="warning"><p>Sign in again to see where the address change ended up.</p><a className="mos-btn mos-btn-primary" href="/suite-manager/">Sign in</a></Notice> : null}
    {contact === 'refused' && change?.target ? <Notice title="This address no longer answers for Settings" variant="info"><p>MOS is running, and the suite has moved. Continue at <a href={`${change.target.scheme}://${change.target.host}/suite-manager/settings`}>{`${change.target.scheme}://${change.target.host}/`}</a>.</p></Notice> : null}
  </>;
}

// How the change this screen started ended. `dnsHelp` is what the track has to
// say when the new name does not point here yet.
export function ChangeOutcome({ address, dnsHelp, outcome }: { address: SuiteAddress; dnsHelp?: ReactNode; outcome: AddressChange | null }) {
  const stillAt = <>Your suite is still at <a href={address.url}>{address.url}</a>.</>;
  if (outcome?.errorCode === 'ADDRESS_CHANGE_CANCELLED') {
    return <Notice title="Move cancelled" variant="info"><p>Nothing changed. {stillAt}</p></Notice>;
  }
  if (outcome?.errorCode === 'DOMAIN_NOT_POINTED_HERE') {
    return <Notice title="The domain never pointed at this server" variant="error"><p>{outcome.diagnostics?.split('\n')[0]}</p><p>{stillAt} Fix the record, then move again.</p></Notice>;
  }
  if (outcome?.status === 'failed') {
    return <Notice title="The address was not changed" variant="error"><p>{stillAt} The reason is in the details below.</p></Notice>;
  }
  if (outcome?.status !== 'applied') return null;
  return <>
    <Notice title="Your suite moved" variant="success">
      <p>It is now published at <a href={address.url}>{address.url}</a>.</p>
      {address.kind === 'domain' && address.resolvesHere !== true ? dnsHelp : null}
      <a className="mos-btn mos-btn-primary" href={address.url}>Open {address.host}</a>
    </Notice>
    <AppReconciliationNotice reconciliation={outcome.result} />
  </>;
}

function AppReconciliationNotice({ reconciliation }: { reconciliation?: AppReconciliationResult | null }) {
  if (!reconciliation || reconciliation.skipped || !['failed', 'partial'].includes(String(reconciliation.status || ''))) return null;
  const failedRuntime = (reconciliation.runtime || []).filter((item) => item.status === 'failed');
  const failedEntries = reconciliation.homepageEntryFailures || [];
  const failedPackages = [...new Set([...failedRuntime, ...failedEntries].map((item) => item.packageId))];
  const details = [
    reconciliation.homepage?.status === 'failed' ? `Homepage routes: ${reconciliation.homepage.errorCode || 'failed'}` : '',
    reconciliation.errorCode ? `Reconciliation: ${reconciliation.errorCode}` : '',
    failedPackages.length ? `Apps: ${failedPackages.join(', ')}` : '',
  ].filter(Boolean).join(' | ');

  return <Notice title="The address changed, but some apps did not follow it" variant="warning">
    <p>Your suite is on its new address. The apps named below could not be rebuilt on it; open them under Apps and apply their runtime again.</p>
    {details ? <p className="suite-meta">{details}</p> : null}
  </Notice>;
}

// The one panel on this screen that renders in both contexts: diagnostics when
// a change of address failed, and ambient detail when it did not.
export function AddressDiagnostics({ status }: { status: AddressStatus }) {
  const change = status.lastChange;
  return <AdvancedPanel facts={[
    { label: 'Recorded address', value: `${status.address.url} (${status.address.kind})` },
    { label: 'Install-time URL', value: status.bootstrapUrl },
    { label: 'Easy Door URL', value: status.easyDoorUrl || 'None: this server is not on a private network' },
    { label: 'Name points here', value: status.address.resolvesHere === null ? 'Not checked' : status.address.resolvesHere ? 'Yes' : 'No' },
    { label: 'Hosting', value: `${status.track} (${status.installContext})` },
    { label: 'Detected server IP', value: status.serverAddress || 'Not detected' },
    { label: 'Last change', value: `${change.status}${change.target ? ` to ${change.target.host}` : ''}${change.stage ? ` (${change.stage})` : ''}${change.errorCode ? ` (${change.errorCode})` : ''}${change.at ? ` at ${change.at}` : ''}` },
  ]} output={change.diagnostics || undefined} reveal={change.status === 'failed' ? 'on-failure' : 'technical-mode'} />;
}
