export function maskValue(value: string): string {
  if (!value) {
    return '';
  }

  if (value.length <= 6) {
    return '••••••';
  }

  return `${'•'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

export function presentValue(value: string, authorized: boolean, secret = false): string {
  if (!secret || authorized) {
    return value;
  }

  return maskValue(value);
}
