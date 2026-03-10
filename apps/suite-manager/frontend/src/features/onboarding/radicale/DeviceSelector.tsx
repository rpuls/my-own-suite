export type RadicaleDevice = 'android' | 'apple' | 'desktop';

type DeviceSelectorProps = {
  onSelect: (device: RadicaleDevice) => void;
  selectedDevice: RadicaleDevice | null;
};

const deviceOptions: Array<{ description: string; id: RadicaleDevice; label: string }> = [
  {
    description: 'iPhone, iPad, or Mac',
    id: 'apple',
    label: 'Apple',
  },
  {
    description: 'Android phone or tablet',
    id: 'android',
    label: 'Android',
  },
  {
    description: 'Windows or another desktop setup',
    id: 'desktop',
    label: 'Windows / Desktop',
  },
];

export function DeviceSelector({ onSelect, selectedDevice }: DeviceSelectorProps) {
  return (
    <div className="suite-device-selector">
      <p className="suite-section-description">Which device do you want to connect?</p>
      <div className="suite-device-options">
        {deviceOptions.map((option) => (
          <button
            className={`suite-device-option${selectedDevice === option.id ? ' is-selected' : ''}`}
            key={option.id}
            onClick={() => onSelect(option.id)}
            type="button"
          >
            <span className="suite-device-option-label">{option.label}</span>
            <span className="suite-device-option-description">{option.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
