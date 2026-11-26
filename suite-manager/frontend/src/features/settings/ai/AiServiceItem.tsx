import { ActionMenu, AdvancedPanel, DestinationLine, DisclosureRow, Icon, Notice, Panel, PanelBand, PanelItem, PlaceTile, Rows, RowSwitch } from '../../../components/ui';
import { AI_VALUES_REFERENCE_URL, appPrivacyUrl } from '../../../lib/links';
import { AppName } from './AiParts';
import type { AiService, AiServiceApp, AiServiceTest } from './model';
import { connectionFacts, rowDestination, serviceMeta, switchHelp, testAnswered, testFailedBody, testFailedTitle, testPassedTitle, usersOf } from './service-words';

// Suite Manager has no page of one app yet, so "its page" is the Apps page it opens from.
const APPS_PATH = '/suite-manager/apps';

export type SwitchError = { message: string; packageId: string; serviceId: string };

export type ServiceItemProps = {
  apps: AiServiceApp[];
  busy: boolean;
  checking: boolean;
  expanded: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onSwitch: (app: AiServiceApp, on: boolean) => void;
  onTest: () => void;
  onToggle: () => void;
  restartFailed: string[];
  service: AiService;
  services: AiService[];
  switchError: SwitchError | null;
  switching: string;
  tested: AiServiceTest | null;
  testing: boolean;
};

function ArrowLink({ children, external = false, href }: { children: string; external?: boolean; href: string }) {
  return <a className="mos-link suite-settings-link" href={href} rel={external ? 'noreferrer' : undefined} target={external ? '_blank' : undefined}>{children}<Icon name="arrow-right" /></a>;
}

// The help line is a status region, so a restart and its end are announced.
function SwitchHelp({ app, failed, other, restarting, service }: { app: AiServiceApp; failed: boolean; other: AiService | null; restarting: boolean; service: AiService }) {
  const help = switchHelp({ app, failed, other, restarting, service });
  const link = help.kind === 'failed'
    ? <ArrowLink href={APPS_PATH}>Restart it from its page</ArrowLink>
    : help.kind === 'features' && app.official && !app.reviewInvalidated ? <ArrowLink external href={appPrivacyUrl(app.packageId)}>What it sends</ArrowLink> : null;
  return <span role="status">{help.text}{link ? <> {link}</> : null}</span>;
}

function AppSwitch({ app, busy, failed, onSwitch, other, restarting, service, switchError }: {
  app: AiServiceApp;
  busy: boolean;
  failed: boolean;
  onSwitch: (app: AiServiceApp, on: boolean) => void;
  other: AiService | null;
  restarting: boolean;
  service: AiService;
  switchError: string | null;
}) {
  return <>
    <RowSwitch
      checked={app.serviceId === service.id}
      description={<SwitchHelp app={app} failed={failed} other={other} restarting={restarting} service={service} />}
      disabled={busy}
      label={<><AppName id={app.packageId} name={app.name} />{app.reviewInvalidated ? <> <span className="mos-pill mos-pill-warning">Experimental</span></> : null}</>}
      onChange={(event) => onSwitch(app, event.target.checked)}
    />
    {switchError ? <Notice title={`${app.name} did not restart`} variant="error"><p>The switch is back where it was. {switchError}</p></Notice> : null}
  </>;
}

function StatusBand(props: Parameters<typeof PanelBand>[0]) {
  return <Panel density="tight"><PanelBand layout="row" {...props} /></Panel>;
}

// The state comes only from the last test MOS ran; Settings runs one when it opens and the last is over 15 minutes old.
function TestOutcome({ busy, checking, onTest, service, tested, testing, users }: { busy: boolean; checking: boolean; onTest: () => void; service: AiService; tested: AiServiceTest | null; testing: boolean; users: AiServiceApp[] }) {
  if (testing || checking) return <StatusBand busy note="This can take up to 30 seconds." title={`Testing ${service.name}…`} tone="info" />;
  const button = (words: string) => <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onTest} type="button">{words}</button>;
  if (service.test.error) {
    return <Notice title={testFailedTitle(service)} variant="warning">
      <p>{testFailedBody(service, users)}</p>
      <div>{button('Test again')}</div>
      <AdvancedPanel output={service.test.error} reveal="on-failure" summary="What went wrong" />
    </Notice>;
  }
  if (!service.test.at) return <StatusBand note="Test it to see that it answers your server." title="Not tested yet" tone="info">{button('Test')}</StatusBand>;
  return <StatusBand icon="check" note={tested?.ok ? testAnswered(tested) : 'Your apps call this same address.'} title={testPassedTitle(service)} tone="accent">{button('Test again')}</StatusBand>;
}

function ServiceApps({ apps, busy, onSwitch, restartFailed, service, services, switchError, switching }: Pick<ServiceItemProps, 'apps' | 'busy' | 'onSwitch' | 'restartFailed' | 'service' | 'services' | 'switchError' | 'switching'>) {
  if (!apps.length) return <p className="suite-meta">None of your apps has AI features yet.</p>;
  return <>
    <Rows>
      {apps.map((app) => <AppSwitch
        app={app}
        busy={busy}
        failed={restartFailed.includes(app.packageId) && app.serviceId === service.id}
        key={app.packageId}
        onSwitch={onSwitch}
        other={services.find((candidate) => candidate.id === app.serviceId && candidate.id !== service.id) ?? null}
        restarting={switching === app.packageId}
        service={service}
        switchError={switchError?.packageId === app.packageId && switchError.serviceId === service.id ? switchError.message : null}
      />)}
    </Rows>
    <DestinationLine variant={service.place}>{rowDestination(service)}</DestinationLine>
  </>;
}

export function ServiceItem(props: ServiceItemProps) {
  const { apps, busy, checking, expanded, onEdit, onRemove, onTest, onToggle, service, tested, testing } = props;
  const users = usersOf(service, apps);
  return <PanelItem flush>
    <DisclosureRow
      aside={service.test.error && !checking ? <span className="mos-pill mos-pill-warning">Not working</span> : null}
      expanded={expanded}
      lead={<PlaceTile place={service.place} />}
      onToggle={onToggle}
      trailing={<ActionMenu ariaLabel={`More for ${service.name}`} disabled={busy} items={[
        ...(checking ? [] : [{ label: 'Test', onSelect: onTest }]),
        { label: 'Change', onSelect: onEdit },
        { label: 'Remove', onSelect: onRemove },
      ]} />}
    >
      <strong>{service.name}</strong>
      <span className="suite-meta suite-ai-service-meta">{serviceMeta(service, apps, checking)}</span>
    </DisclosureRow>
    {expanded ? <div className="suite-ai-grants">
      <TestOutcome busy={busy || checking} checking={checking} onTest={onTest} service={service} tested={tested} testing={testing} users={users} />
      <ServiceApps {...props} />
      <AdvancedPanel facts={connectionFacts(service, users)} reveal="technical-mode" summary="Connection details">
        <p><ArrowLink external href={AI_VALUES_REFERENCE_URL}>{'${ai.*} in the manifest reference'}</ArrowLink></p>
      </AdvancedPanel>
    </div> : null}
  </PanelItem>;
}
