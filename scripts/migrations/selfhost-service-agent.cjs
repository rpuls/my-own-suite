const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: '2026-05-30-selfhost-service-agent',
  migrate({ repoRoot, vpsDir }) {
    const reconcileScript = path.join(repoRoot, 'agents', 'selfhost', 'reconcile-host-agents.sh');
    const isSelfhostInstall =
      fs.existsSync(path.join(vpsDir, 'docker-compose.selfhost.yml')) ||
      fs.existsSync(path.join(vpsDir, 'services', 'suite-manager', '.env.selfhost')) ||
      fs.existsSync('/etc/mos-selfhost.env');

    if (!isSelfhostInstall) {
      return {
        changed: false,
        details: ['checkout is not marked as self-host'],
      };
    }

    if (process.platform !== 'linux') {
      return {
        changed: false,
        details: ['host-agent reconciliation only runs on Linux'],
      };
    }

    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      return {
        changed: false,
        details: ['host-agent reconciliation requires root privileges'],
      };
    }

    if (!fs.existsSync(reconcileScript)) {
      return {
        changed: false,
        details: ['host-agent reconciliation script is missing'],
      };
    }

    const result = spawnSync('bash', [reconcileScript, repoRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    if (result.status !== 0) {
      return {
        changed: false,
        details: [`host-agent reconciliation failed: ${output || `exit ${result.status}`}`],
      };
    }

    return {
      changed: true,
      details: [output || 'host-agent reconciliation completed'],
    };
  },
};
