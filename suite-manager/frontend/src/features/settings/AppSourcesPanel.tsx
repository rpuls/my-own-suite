import { useEffect, useState } from 'react';

import { ActionMenu, AdvancedPanel, Dialog, Icon, Notice, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList } from '../../components/ui';
import { jsonResponse } from '../../lib/api';

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

function repoLabel(repository: string) {
  try {
    const url = new URL(repository);
    return url.pathname.replace(/^\//u, '') || url.hostname;
  } catch {
    return repository;
  }
}

function whenLabel(at: string | null) {
  if (!at) return 'never';
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return 'never';
  const minutes = Math.round((Date.now() - parsed) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

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
        <strong>{repoLabel(source.repository)}</strong>
        <span className="suite-meta">
          {count === null ? 'No apps read from this source yet' : `${count} ${count === 1 ? 'app' : 'apps'}`}
          {' · '}
          {source.status === 'active' ? `checked ${whenLabel(source.catalog.checkedAt)}` : source.statusReason || source.status}
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
          <a href={source.repository} rel="noreferrer" target="_blank">Open {repoLabel(source.repository)}<Icon name="external" /></a>
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

  async function refresh(source: AppSource) {
    setBusyId(source.id);
    try {
      await jsonResponse<{ catalog: SourceCatalog }>(
        await fetch(`/suite-manager/api/apps/sources/${encodeURIComponent(source.id)}/refresh`, { method: 'POST' }),
        'Unable to check that source.',
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to check that source.');
    } finally {
      setBusyId('');
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
        <AdvancedPanel facts={sources.map((source) => ({
          code: true,
          label: repoLabel(source.repository),
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
      title={`Remove ${repoLabel(removing.repository)}?`}
    >
      <p>Its apps stop being offered on the Apps page. Anything you already installed from it keeps running exactly as it is, with its settings and its data — but MOS will no longer offer it updates, because only this source knows when a newer version exists.</p>
      {installedFrom ? <p className="suite-meta">This source currently offers {installedFrom} {installedFrom === 1 ? 'app' : 'apps'}.</p> : null}
      <p className="suite-meta">You can add the same repository again later. Nothing is deleted from your server by removing it.</p>
      {removeError ? <Notice title="This source was not removed" variant="warning"><p>{removeError}</p></Notice> : null}
    </Dialog> : null}
  </>;
}
