import customizeYaml from './customize-yaml.json';
import { DisclaimerNotice } from './DisclaimerNotice';

const AI_SETTINGS_PATH = '/suite-manager/settings#set-ai';

// Customize still hands the owner config files; the card points at the way most
// owners will actually arrange the dashboard, an AI, before the files.
export function CustomizeYamlNotice() {
  return <DisclaimerNotice
    action={{ href: AI_SETTINGS_PATH, label: 'Connect an AI' }}
    copy={customizeYaml}
    variant="info"
  />;
}
