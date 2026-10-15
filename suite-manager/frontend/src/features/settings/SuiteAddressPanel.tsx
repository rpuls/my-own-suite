import { Notice, Panel, PanelBody, PanelHead } from '../../components/ui';
import { HomeServerAddress } from './address/HomeServerAddress';
import { useSuiteAddress } from './address/model';
import { PublicServerAddress } from './address/PublicServerAddress';
import { ContactNotices } from './address/shared';

// The track is decided once, by the server, and each track is its own
// component: a home server and a public server prove a domain in different
// ways, and neither screen should carry the other's conditions.
export function SuiteAddressPanel() {
  const suite = useSuiteAddress();
  const { contact, loadError, status } = suite;

  if (!status) {
    return <Panel>
      <PanelHead heading="h3" title="Suite address"><p>Where every app and your Homepage are published.</p></PanelHead>
      <PanelBody>
        {loadError ? <Notice title="The suite address could not be loaded" variant="error"><p>{loadError}</p></Notice> : null}
        <ContactNotices change={null} contact={contact} />
        {contact === 'ok' && !loadError ? <p className="suite-meta">Loading the suite address...</p> : null}
      </PanelBody>
    </Panel>;
  }

  return status.track === 'public-server'
    ? <PublicServerAddress status={status} suite={suite} />
    : <HomeServerAddress status={status} suite={suite} />;
}
