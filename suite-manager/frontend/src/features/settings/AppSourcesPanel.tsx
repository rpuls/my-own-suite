import { useEffect, useState } from 'react';

import { ActionMenu, AdvancedPanel, Dialog, Icon, Notice, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList } from '../../components/ui';
import { jsonResponse } from '../../lib/api';
import { appSourceLabel, sourceCheckedLabel } from '../../lib/app-sources';

// What MOS last learned from a source, and when it may ask again.
type SourceCatalog = {
  checkedAt: string | null;
  error: { at: string | null; code: string; failures: number; message: string; retryAt: string | null } | null;
  fetchedAt: string | null;
  nextCheckAt: string | null;
  packageCount: number | null;
  revision: string | null;
};

type AppSource = {
  addedAt: string;
  catalog: SourceCatalog;
  catalogPath: string;
  id: string;
  kind: string;
  mosReviewed: false;
  official: false;
  publisher: string | null;
  repository: string;
  revision: string | null;
  signed: boolean;
  status: 'active' | 'unavailable' | 'compromised' | 'removed';
  statusReason: string | null;
  trust: string;
  updatedAt: string;
};

// A refresh answers 200 even when the host refused, so only this says what happened.
// `not-due` is unreachable here: the owner asking directly always forces the check.
type RefreshOutcome = 'failed' | 'moved' | 'not-active' | 'unchanged';

// Plain language for what the git host actually answered, because the answers need
// opposite responses from the owner. A repository that has gone private is theirs to
// look at; a rate limit resolves on its own. MOS never claims the repository was
// deleted: the host returns the same answer whether it was deleted, renamed, or made
// private, so saying which would be a guess.
function failureCopy(error: NonNullable<SourceCatalog['error']>): { detail: string; title: string } {
  if (error.code === 'SOURCE_NOT_VISIBLE') {
    return {
      detail: 'GitHub will not show this repository to an anonymous request. It may have been deleted, renamed, or made private. Open it to see which, then refresh.',
      title: 'This repository no longer answers',
    };
  }
  if (error.code === 'SOURCE_RATE_LIMITED') {
    return {
      detail: 'GitHub is limiting how often this server may ask without an account. MOS waits and tries again on its own; nothing is wrong with the source.',
      title: 'GitHub asked MOS to slow down',
    };
  }
  return { detail: error.message, title: 'MOS could not check this source' };
}

type RefreshReport = { icon: 'check' | 'refresh'; note: string; title: string; tone: 'info' | 'warning' };

function refreshCopy(label: string, result: { catalog: SourceCatalog; outcome: RefreshOutcome }): RefreshReport {
  if (result.outcome === 'failed' && result.catalog.error) {
    // The row above already carries the failure; verbatim here reads as two failures.
    return {
      icon: 'refresh',
      note: `${failureCopy(result.catalog.error).title}. The reason is on its row above, and the apps it last published stay listed.`,
      title: `MOS could not re-read ${label}`,
      tone: 'warning',
    };
  }
  if (result.outcome === 'not-active') {
    return {
      icon: 'refresh',
      note: `MOS does not read ${label} while the source is not active. Anything you installed from it keeps running.`,
      title: 'This source is not active',
      tone: 'warning',
    };
  }
  const count = result.catalog.packageCount;
  const apps = count === null ? 'no apps' : `${count} ${count === 1 ? 'app' : 'apps'}`;
  if (result.outcome === 'moved') {
    return {
      icon: 'check',
      note: `${label} has new commits. MOS re-read what it publishes: ${apps}. If one of them is an app you installed, the Apps page now shows whether its version changed.`,
      title: 'Source re-read',
      tone: 'info',
    };
  }
  return {
    icon: 'check',
    note: `${label} is at the same commit MOS last read, so nothing it publishes has changed. It offers ${apps}.`,
    title: 'Already up to date',
    tone: 'info',
  };
}

function SourceRow({ busy, onRefresh, onRemove, source }: {
  busy: boolean;
  onRefresh: () => void;
  onRemove: () => void;
  source: AppSource;
}) {
  const failure = source.catalog.error ? failureCopy(source.catalog.error) : null;
  const count = source.catalog.packageCount;
  return <PanelItem quiet={source.status !== 'active'}>
    <div className="suite-source-row">
      <div className="suite-source-main">
        <strong>{appSourceLabel(source.repository)}</strong>
        <span className="suite-meta">
          {count === null ? 'No apps read from this source yet' : `${count} ${count === 1 ? 'app' : 'apps'}`}
          {' · '}
          {source.status === 'active' ? `checked ${sourceCheckedLabel(source.catalog.checkedAt)}` : source.statusReason || source.status}
        </span>
      </div>
      <span className="suite-source-trailing">
        {failure ? <span className="mos-pill mos-pill-warning" title={failure.detail}>Needs a look</span> : null}
        <ActionMenu disabled={busy} items={[
          { label: busy ? 'Refreshing...' : 'Refresh now', onSelect: onRefresh },
          { label: 'Remove source', onSelect: onRemove },
        ]} />
      </span>
    </div>
    {failure ? <div className="suite-source-problem">
      <Notice title={failure.title} variant="warning">
        <p>{failure.detail}</p>
        <p>
          <a href={source.repository} rel="noreferrer" target="_blank">Open {appSourceLabel(source.repository)}<Icon name="external" /></a>
          {' — its apps stay listed and anything you installed from it keeps running.'}
        </p>
      </Notice>
    </div> : null}
  </PanelItem>;
}

// Where the owner sees, refreshes, and removes the app sources they have added.
// Adding one happens on the Apps page, where pasting a repository URL shows what it
// publishes before anything is registered — the decision belongs next to the thing
// being decided. This is the standing list of what that decision left behind.
export function AppSourcesPanel() {
  const [sources, setSources] = useState<AppSource[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [removing, setRemoving] = useState<AppSource | null>(null);
  const [removeError, setRemoveError] = useState('');
  const [orphaned, setOrphaned] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState<AppSource | null>(null);
  const [refreshed, setRefreshed] = useState<RefreshReport | null>(null);

  async function load() {
    try {
      const result = await jsonResponse<{ sources: AppSource[] }>(
        await fetch('/suite-manager/api/apps/sources'),
        'Unable to load your app sources.',
      );
      // A removed source is history, not something the owner can act on.
      setSources(result.sources.filter((source) => source.status !== 'removed'));
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load your app sources.');
    }
  }

  useEffect(() => { void load(); }, []);

  // Only a transport failure reaches the catch; anything the host answered is an outcome.
  async function refresh(source: AppSource) {
    setBusyId(source.id);
    setRefreshing(source);
    setRefreshed(null);
    try {
      const result = await jsonResponse<{ catalog: SourceCatalog; outcome: RefreshOutcome }>(
        await fetch(`/suite-manager/api/apps/sources/${encodeURIComponent(source.id)}/refresh`, { method: 'POST' }),
        'Unable to check that source.',
      );
      setRefreshed(refreshCopy(appSourceLabel(source.repository), result));
      await load();
    } catch (caught) {
      setRefreshed({
        icon: 'refresh',
        note: `${caught instanceof Error ? caught.message : 'Unable to check that source.'} Nothing about this source changed.`,
        title: 'The check did not run',
        tone: 'warning',
      });
    } finally {
      setBusyId('');
      setRefreshing(null);
    }
  }

  async function remove(source: AppSource) {
    setBusyId(source.id);
    setRemoveError('');
    try {
      const result = await jsonResponse<{ orphanedInstanceIds: string[] }>(
        await fetch(`/suite-manager/api/apps/sources/${encodeURIComponent(source.id)}/remove`, { method: 'POST' }),
        'Unable to remove that source.',
      );
      setOrphaned(result.orphanedInstanceIds.length);
      setRemoving(null);
      await load();
    } catch (caught) {
      setRemoveError(caught instanceof Error ? caught.message : 'Unable to remove that source.');
    } finally {
      setBusyId('');
    }
  }

  const installedFrom = removing
    ? sources.find((source) => source.id === removing.id)?.catalog.packageCount ?? null
    : null;

  return <>
    <Panel>
      <PanelHead title="App sources you added" />
      {sources.length ? <PanelList>
        {sources.map((source) => <SourceRow
          busy={busyId === source.id}
          key={source.id}
          onRefresh={() => void refresh(source)}
          onRemove={() => { setRemoving(source); setRemoveError(''); }}
          source={source}
        />)}
      </PanelList> : null}
      {!sources.length ? <PanelBody>
        <p className="suite-meta">You have not added any app sources. The MOS catalog is the only place your apps come from.</p>
        <p className="suite-meta">A source is a public GitHub repository publishing one app, or a catalog of them, in a <code>.mos</code> folder. Paste its URL into the search box on the Apps page to see what it offers before adding it. MOS does not review these apps and cannot vouch for them.</p>
      </PanelBody> : null}
      {error ? <PanelBody><Notice title="Your app sources could not be loaded" variant="warning"><p>{error}</p></Notice></PanelBody> : null}
      {/* The action menu has closed by now, so the panel is what reports the check. */}
      {refreshing ? <PanelBand
        busy
        note="Asking the repository which commit it is at, and re-reading its apps if it has moved."
        title={`Checking ${appSourceLabel(refreshing.repository)}`}
        tone="info"
      /> : null}
      {!refreshing && refreshed ? <PanelBand
        icon={refreshed.icon}
        note={refreshed.note}
        title={refreshed.title}
        tone={refreshed.tone}
      >
        <button className="mos-btn mos-btn-ghost" onClick={() => setRefreshed(null)} type="button">Dismiss</button>
      </PanelBand> : null}
      {orphaned !== null ? <PanelBand
        icon="check"
        title="Source removed"
        note={orphaned
          ? `${orphaned} installed ${orphaned === 1 ? 'app' : 'apps'} came from it and ${orphaned === 1 ? 'keeps' : 'keep'} running. ${orphaned === 1 ? 'It' : 'They'} will not be offered updates any more.`
          : 'Nothing was installed from it.'}
        tone="info"
      >
        <button className="mos-btn mos-btn-ghost" onClick={() => setOrphaned(null)} type="button">Dismiss</button>
      </PanelBand> : null}
      {sources.length ? <PanelBody>
        <p className="suite-meta">Refreshing re-reads the apps a source publishes. That listing is what the Apps page offers, and what tells an app you installed from the source that a newer version exists — applying it happens on that app&apos;s own page under Apps.</p>
        <AdvancedPanel facts={sources.map((source) => ({
          code: true,
          label: appSourceLabel(source.repository),
          value: `${source.revision ? source.revision.slice(0, 12) : 'unresolved'} · next check ${source.catalog.nextCheckAt || 'now'}`,
        }))} reveal="technical-mode" summary="Source revisions">
          <p>MOS asks each source which commit it is at, no more often than every few hours, and only downloads it again when that commit has moved. A source that fails to answer is asked less and less often rather than more.</p>
        </AdvancedPanel>
      </PanelBody> : null}
    </Panel>

    {removing ? <Dialog
      footer={<>
        <button className="mos-btn mos-btn-secondary" disabled={Boolean(busyId)} onClick={() => setRemoving(null)} type="button">Keep it</button>
        <button className="mos-btn mos-btn-danger" disabled={Boolean(busyId)} onClick={() => void remove(removing)} type="button">{busyId ? 'Removing...' : 'Remove source'}</button>
      </>}
      onClose={() => setRemoving(null)}
      title={`Remove ${appSourceLabel(removing.repository)}?`}
    >
      <p>Its apps stop being offered on the Apps page. Anything you already installed from it keeps running exactly as it is, with its settings and its data — but MOS will no longer offer it updates, because only this source knows when a newer version exists.</p>
      {installedFrom ? <p className="suite-meta">This source currently offers {installedFrom} {installedFrom === 1 ? 'app' : 'apps'}.</p> : null}
      <p className="suite-meta">You can add the same repository again later. Nothing is deleted from your server by removing it.</p>
      {removeError ? <Notice title="This source was not removed" variant="warning"><p>{removeError}</p></Notice> : null}
    </Dialog> : null}
  </>;
}
