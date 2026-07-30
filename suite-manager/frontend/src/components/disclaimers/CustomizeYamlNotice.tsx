import customizeYaml from './customize-yaml.json';
import { DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../../lib/links';
import { DisclaimerNotice } from './DisclaimerNotice';

// Customize is the one screen in MOS that stops pretending to be a product and
// hands the owner a config file. Saying so plainly costs nothing and buys a lot:
// someone who was told the screen is rough forgives it, while someone who
// discovers it themselves concludes the whole platform is like this.
export function CustomizeYamlNotice() {
  return <DisclaimerNotice
    copy={customizeYaml}
    // The ask for help lives here rather than in the JSON because it carries
    // links, and those come from lib/links so an installed suite can never
    // point somewhere stale.
    details={<p>
      A real editor is on the list. MOS is built by very few people, so we can't build everything at
      once — if this is the piece you want next, say so on{' '}
      <a href={DISCORD_INVITE_URL} rel="noreferrer" target="_blank">Discord</a> or help build it on{' '}
      <a href={GITHUB_REPO_URL} rel="noreferrer" target="_blank">GitHub</a>.
    </p>}
    variant="info"
  />;
}
