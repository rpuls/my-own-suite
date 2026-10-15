const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The key the Hyper-V lab is built to trust, which also gives the lab user passwordless
// sudo (see renderSeed). Git-ignored and made on first use, so it never leaves this PC.
const labSshKeyPath = path.resolve(__dirname, '..', '..', '.mos-smoke', 'lab-ssh', 'id_ed25519');

function ensureLabSshKey(keyPath = labSshKeyPath) {
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'mos-lab', '-f', keyPath], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) {
      throw new Error(`Could not make the lab SSH key with ssh-keygen: ${result.error?.message || result.stderr}`);
    }
    // Windows OpenSSH ignores a key that inherits the folder's permissions.
    if (process.platform === 'win32') {
      spawnSync('icacls', [keyPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { windowsHide: true });
    }
  }
  return { privateKey: keyPath, publicKey: `${keyPath}.pub` };
}

module.exports = { ensureLabSshKey, labSshKeyPath };
