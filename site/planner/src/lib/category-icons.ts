export const CATEGORY_ICONS = [
  { id: 'home', label: 'Smart home' },
  { id: 'image', label: 'Photos' },
  { id: 'router', label: 'Router / network' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'folder', label: 'Files' },
  { id: 'office', label: 'Office' },
  { id: 'key', label: 'Passwords' },
  { id: 'globe', label: 'Browser / web' },
  { id: 'mail', label: 'Email' },
  { id: 'message', label: 'Communication' },
  { id: 'play', label: 'Media' },
  { id: 'notes', label: 'Notes' },
  { id: 'storage', label: 'Storage' },
  { id: 'shield', label: 'Security' },
  { id: 'wallet', label: 'Finance' },
  { id: 'health', label: 'Health' },
  { id: 'code', label: 'Development' },
  { id: 'tag', label: 'Other' },
] as const;

export type CategoryIconId = (typeof CATEGORY_ICONS)[number]['id'];
