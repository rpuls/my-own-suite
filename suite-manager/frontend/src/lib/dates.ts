// The way someone says a date out loud: today and yesterday by name, this year
// without the year, anything older in full.
export function whenWords(value: string | null) {
  if (!value) return 'Unknown time';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const clock = parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - parsed.getTime()) / 86_400_000);
  if (days < 0) return `Today, ${clock}`;
  if (days === 0) return `Yesterday, ${clock}`;
  const sameYear = parsed.getFullYear() === new Date().getFullYear();
  return `${parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })}, ${clock}`;
}
