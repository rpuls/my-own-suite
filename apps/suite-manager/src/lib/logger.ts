export function log(message: string): void {
  console.log(`[suite-manager] ${new Date().toISOString()} ${message}`);
}
