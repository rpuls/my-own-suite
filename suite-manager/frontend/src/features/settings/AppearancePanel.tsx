import { Panel, PanelHead, PanelItem, PanelList, Row, Segmented } from '../../components/ui';
import { useThemePreference, type ThemePreference } from '../../lib/theme';

const THEME_OPTIONS: Array<{ label: string; value: ThemePreference }> = [
  { label: 'Auto', value: 'auto' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
];

export function AppearancePanel() {
  const { preference, setPreference } = useThemePreference();

  return <Panel>
    <PanelHead heading="h3" title="Appearance">
      <p>Auto follows the light or dark mode of this device. Your choice is kept in this browser only.</p>
    </PanelHead>
    <PanelList><PanelItem>
      <Row label="Theme"><Segmented<ThemePreference> label="Theme" onChange={setPreference} options={THEME_OPTIONS} value={preference} /></Row>
    </PanelItem></PanelList>
  </Panel>;
}
