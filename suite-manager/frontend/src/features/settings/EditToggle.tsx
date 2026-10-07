export function EditToggle({ editing, label, onToggle }: { editing: boolean; label: string; onToggle: () => void }) {
  return <button aria-expanded={editing} className={`mos-btn ${editing ? 'mos-btn-ghost' : 'mos-btn-secondary'}`} onClick={onToggle} type="button">{editing ? 'Cancel' : label}</button>;
}
