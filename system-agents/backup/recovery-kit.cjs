// The sheet of paper an owner keeps. What the machine remembers about its key
// lives in `system-agents/lib/recovery-key-store.cjs`, with the key itself.
//
// The kit is plain text on purpose. A PDF would be a dependency, and the file's
// whole job is to survive being printed, photographed, or copied onto paper by
// hand. It names the destinations so an owner who has lost the server still
// knows which bucket to point a new one at, and it never carries a storage
// credential: the provider's console is the credential's home.

function kitDate(now) {
  return now.toISOString().slice(0, 10);
}

function describeDestination(destination) {
  if (destination.kind !== 'bucket') return `  Drive: ${destination.label}`;
  return [
    `  Bucket: ${destination.label}`,
    `    Endpoint: ${destination.endpoint}`,
    `    Bucket name: ${destination.bucket}`,
    `    Folder: ${destination.folder || '(none)'}`,
    `    Region: ${destination.region || '(none)'}`,
  ].join('\n');
}

function recoveryKitFilename({ hostname, now = new Date() }) {
  const safeHost = String(hostname || 'server').toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'server';
  return `mos-recovery-kit-${safeHost}-${kitDate(now)}.txt`;
}

function recoveryKitText({ asksForPassword = false, destinations = [], encryptedDisk = false, homeAddress, hostname, key, now = new Date() }) {
  return [
    'My Own Suite — recovery kit',
    '',
    `Made on ${kitDate(now)}`,
    `Server: ${hostname || 'unknown'}`,
    `Home address: ${homeAddress || 'unknown'}`,
    '',
    'Recovery key:',
    '',
    `    ${key}`,
    '',
    'Anyone who has this key and can reach your backups can read them. Keep it somewhere safe, and not only on this server.',
    '',
    ...(encryptedDisk ? [
      'This key also opens the encrypted disk in this server.',
      '',
      ...(asksForPassword ? [
        'That server is set to ask for your Suite Manager password after every restart before it opens that disk, so',
        'day to day you type your password and never this key. If you forget that password, or the security chip stops',
        'answering, the page at the address above takes the key above instead. Nothing is lost while it waits.',
      ] : [
        'The server normally opens its own disk using its security chip and never asks you for anything. If it ever',
        'cannot — after a firmware change, or if the disk is moved to another machine — it still starts, and the page',
        'at the address above asks for the key above instead of showing your apps. Nothing is lost while it waits.',
      ]),
      '',
    ] : []),
    'Backup destinations MOS knows right now:',
    ...(destinations.length ? destinations.map(describeDestination) : ['  (none connected yet)']),
    '',
    'How to recover onto another machine:',
    '',
    'Install MOS on the replacement machine and create an owner account on it so you can sign in.',
    'Open Backup & Restore, connect the same drive or the same bucket, and MOS will say the backups there were written by another server.',
    'Choose Enter recovery key, type the key above, and the restore points appear so you can restore one.',
    'When the restore finishes, sign in with the owner password from the server this kit came from, and re-apply your domain under HTTPS if you were using one.',
    "Your storage provider's console holds your access key; a new key for the same bucket works too.",
    '',
  ].join('\n');
}

module.exports = { recoveryKitFilename, recoveryKitText };
