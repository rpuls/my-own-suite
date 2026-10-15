import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Icon, Panel, PanelBody, type IconName } from '../../components/ui';
import { AppSourcesPanel } from './AppSourcesPanel';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { EmailRelayPanel } from './EmailRelayPanel';
import { EncryptionPanel } from './EncryptionPanel';
import { OwnerAccountPanel } from './OwnerAccountPanel';
import { SecurityActivityPanel } from './SecurityActivityPanel';
import { SuiteAddressPanel } from './SuiteAddressPanel';
import { TechnicalControlsPanel } from './TechnicalControlsPanel';

type GroupId = 'advanced' | 'apps' | 'help' | 'security' | 'suite';

type SettingId = 'activity' | 'address' | 'diagnostics' | 'email' | 'encryption' | 'password' | 'sources' | 'technical';

const GROUPS: Array<{ description: string; id: GroupId; title: string }> = [
  { description: 'Where your suite lives and how it talks to the outside world.', id: 'suite', title: 'Your suite' },
  { description: 'Who controls this suite and how it protects your data.', id: 'security', title: 'Account & security' },
  { description: 'Where your apps come from.', id: 'apps', title: 'Apps' },
  { description: 'Extra detail for people who want to see under the hood.', id: 'advanced', title: 'Advanced' },
  { description: 'For when something is not working.', id: 'help', title: 'Help' },
];

// The one index of this page: it drives the sidebar, the search and the order of
// the cards, so a new setting is one entry here and one card in SETTING_CARDS.
const SETTINGS: Array<{ group: GroupId; icon: IconName; id: SettingId; keywords: string; title: string }> = [
  { group: 'suite', icon: 'globe', id: 'address', keywords: 'domain certificate https url cloudflare acme dns token home where lives move easy door', title: 'Suite address' },
  { group: 'suite', icon: 'mail', id: 'email', keywords: 'smtp mail email relay host port username password from sender test notifications', title: 'Email relay' },
  { group: 'security', icon: 'key', id: 'password', keywords: 'password owner account login change sign in', title: 'Owner password' },
  { group: 'security', icon: 'lock', id: 'encryption', keywords: 'disk encryption boot startup password recovery key tpm chip theft stolen', title: 'Disk encryption' },
  { group: 'security', icon: 'shield', id: 'activity', keywords: 'security events activity log refused throttled audit', title: 'Security activity' },
  { group: 'apps', icon: 'apps', id: 'sources', keywords: 'app sources catalog repository github refresh revisions extra', title: 'App sources' },
  { group: 'advanced', icon: 'settings', id: 'technical', keywords: 'technical controls advanced logs config developer overrides expert', title: 'Technical controls' },
  { group: 'help', icon: 'download', id: 'diagnostics', keywords: 'diagnostics help support troubleshoot problem broken not working logs ai', title: 'Diagnostics file' },
];

// Every whitespace-separated term has to appear somewhere in the setting.
function matchesQuery(setting: typeof SETTINGS[number], query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const groupTitle = GROUPS.find((group) => group.id === setting.group)?.title || '';
  const haystack = `${setting.title} ${groupTitle} ${setting.keywords}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

const SETTING_CARDS: Record<SettingId, () => ReactNode> = {
  activity: () => <SecurityActivityPanel />,
  address: () => <SuiteAddressPanel />,
  diagnostics: () => <DiagnosticsPanel />,
  email: () => <EmailRelayPanel />,
  encryption: () => <EncryptionPanel />,
  password: () => <OwnerAccountPanel />,
  sources: () => <AppSourcesPanel />,
  technical: () => <TechnicalControlsPanel />,
};

// Distance from the top of the viewport at which a card counts as the one being
// read, and the margin a jump leaves above it.
const READING_LINE = 160;

function scrollToAnchor(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// The setting being read: the last visible card whose top has passed the reading
// line, or the last card once the page cannot scroll any further.
function useActiveSetting(visible: SettingId[]) {
  const [active, setActive] = useState<SettingId | null>(visible[0] ?? null);
  const key = visible.join(' ');
  useEffect(() => {
    function update() {
      let current = visible[0] ?? null;
      for (const id of visible) {
        const card = document.getElementById(`set-${id}`);
        if (card && card.getBoundingClientRect().top < READING_LINE) current = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = visible.at(-1) ?? current;
      setActive(current);
    }
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [key]);
  return [active, setActive] as const;
}

function SettingsSidebar({ active, onClear, onJump, onQuery, query, visible }: {
  active: SettingId | null;
  onClear: () => void;
  onJump: (id: SettingId) => void;
  onQuery: (query: string) => void;
  query: string;
  visible: SettingId[];
}) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName || '');
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return <aside className="suite-settings-aside">
    <div className="suite-settings-search">
      <Icon name="search" />
      <input
        aria-label="Search settings"
        className="suite-input"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onClear(); }}
        placeholder="Search settings"
        ref={searchRef}
        type="search"
        value={query}
      />
      {query ? <button aria-label="Clear search" className="suite-settings-search-clear" onClick={onClear} type="button"><Icon name="x" /></button> : <kbd aria-hidden="true">/</kbd>}
    </div>
    {query.trim() ? <p className="suite-meta suite-settings-found" role="status">{visible.length === 1 ? '1 setting found' : `${visible.length} settings found`}</p> : null}

    <nav aria-label="Settings sections" className="suite-settings-nav">
      {GROUPS.map((group) => {
        const items = SETTINGS.filter((setting) => setting.group === group.id && visible.includes(setting.id));
        if (!items.length) return null;
        return <div className="suite-settings-nav-group" key={group.id}>
          <button className="mos-eyebrow suite-settings-nav-heading" onClick={() => scrollToAnchor(`grp-${group.id}`)} type="button">{group.title}</button>
          {items.map((setting) => <button aria-current={active === setting.id ? 'location' : undefined} className="suite-settings-nav-item" key={setting.id} onClick={() => onJump(setting.id)} type="button">
            <Icon name={setting.icon} />{setting.title}
          </button>)}
        </div>;
      })}
    </nav>

    <div className="suite-settings-aside-help">
      <strong>Something not working?</strong>
      <p className="suite-meta">Gather what MOS knows into one file you can share.</p>
      <a className="mos-link suite-settings-link" href="#set-diagnostics" onClick={(event) => { event.preventDefault(); onClear(); onJump('diagnostics'); }}>Create diagnostics file<Icon name="arrow-right" /></a>
    </div>
  </aside>;
}

export function SettingsScreen() {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => SETTINGS.filter((setting) => matchesQuery(setting, query)).map((setting) => setting.id), [query]);
  const [active, setActive] = useActiveSetting(visible);

  function jump(id: SettingId) {
    setActive(id);
    // A cleared search re-shows the target in the same render, so wait for it.
    window.requestAnimationFrame(() => scrollToAnchor(`set-${id}`));
  }

  return <section className="mos-shell mos-page mos-page-wider">
    <div className="suite-settings-layout">
      <SettingsSidebar
        active={active}
        onClear={() => setQuery('')}
        onJump={jump}
        onQuery={(next) => { setQuery(next); window.scrollTo({ top: 0 }); }}
        query={query}
        visible={visible}
      />

      <div className="suite-settings-main">
        <div className="suite-hero"><h1>Settings</h1><p className="suite-lead mos-body-lg">How your suite is reached, who controls it, and how it keeps itself safe.</p></div>

        {!visible.length ? <Panel><PanelBody>
          <h2 className="mos-card-title">No settings match &ldquo;{query.trim()}&rdquo;</h2>
          <p className="suite-meta">Try a broader word like &ldquo;email&rdquo;, &ldquo;password&rdquo; or &ldquo;domain&rdquo;.</p>
          <div><button className="mos-btn mos-btn-secondary" onClick={() => setQuery('')} type="button">Clear search</button></div>
        </PanelBody></Panel> : null}

        {/* Hidden rather than unmounted, so a search never throws away a half-typed form. */}
        {GROUPS.map((group) => {
          const settings = SETTINGS.filter((setting) => setting.group === group.id);
          return <section className="suite-settings-group" hidden={!settings.some((setting) => visible.includes(setting.id))} id={`grp-${group.id}`} key={group.id}>
            <div className="suite-settings-group-head">
              <h2 className="mos-eyebrow">{group.title}</h2>
              <p className="suite-meta">{group.description}</p>
            </div>
            {settings.map((setting) => <div className="suite-setting" hidden={!visible.includes(setting.id)} id={`set-${setting.id}`} key={setting.id}>
              {SETTING_CARDS[setting.id]()}
            </div>)}
          </section>;
        })}
      </div>
    </div>
  </section>;
}
