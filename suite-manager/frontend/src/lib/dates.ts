// For whenWords in the middle of a sentence: "Saved today, 09.12."
export function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function parsedDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function clockOf(parsed: Date) {
  return parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Today and yesterday by name with the clock; null for anything older.
function recentWords(parsed: Date) {
  const clock = clockOf(parsed);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - parsed.getTime()) / 86_400_000);
  if (days < 0) return `Today, ${clock}`;
  return days === 0 ? `Yesterday, ${clock}` : null;
}

function olderDate(parsed: Date, month: 'long' | 'short') {
  const sameYear = parsed.getFullYear() === new Date().getFullYear();
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month, ...(sameYear ? {} : { year: 'numeric' }) });
}

// The way someone says a date out loud: today and yesterday by name, this year
// without the year, anything older in full.
export function whenWords(value: string | null) {
  if (!value) return 'Unknown time';
  const parsed = parsedDate(value);
  if (!parsed) return value;
  return recentWords(parsed) ?? `${olderDate(parsed, 'long')}, ${clockOf(parsed)}`;
}

// whenWords for a line that must stay short: anything before yesterday is a short date without the clock.
export function shortWhenWords(value: string) {
  const parsed = parsedDate(value);
  if (!parsed) return value;
  return recentWords(parsed) ?? olderDate(parsed, 'short');
}
