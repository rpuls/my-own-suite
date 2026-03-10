export type RadicaleDevice = 'android' | 'ios' | 'mac' | 'windows';

type DeviceSelectorProps = {
  onSelect: (device: RadicaleDevice) => void;
  selectedDevice: RadicaleDevice | null;
};

const deviceOptions: Array<{ description: string; id: RadicaleDevice; label: string }> = [
  {
    description: 'iPhone or iPad',
    id: 'ios',
    label: 'iPhone / iPad',
  },
  {
    description: 'Android phone or tablet',
    id: 'android',
    label: 'Android',
  },
  {
    description: 'MacBook, iMac, or another Mac',
    id: 'mac',
    label: 'Mac',
  },
  {
    description: 'Windows PC or laptop',
    id: 'windows',
    label: 'Windows',
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
