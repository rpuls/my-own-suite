import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function sshArgs({ key, target }, knownHosts) {
  return [
    '-i', key,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    // A lab gets a new host key with every rebuild, so one is trusted for one run.
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${knownHosts.replaceAll('\\', '/')}`,
    target,
  ];
}

// One root command on the lab, with `input` on its stdin, resolving to its output.
export function runOnLab(shell, command, { input = null, knownHosts = path.join(os.tmpdir(), 'mos-e2e-known-hosts') } = {}) {
  if (!shell) throw new Error('There is no root shell on the lab. Rebuild the Hyper-V lab (npm run smoke:hyperv:reset bakes in a key), or set MOS_E2E_LAB_SSH and MOS_E2E_LAB_SSH_KEY.');
  const script = `sudo -n bash -c "$(echo ${Buffer.from(command).toString('base64')} | base64 -d)"`;
  const [program, args] = shell.target === 'local'
    ? ['sudo', ['-n', 'bash', '-c', command]]
    : ['ssh', [...sshArgs(shell, knownHosts), script]];
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`The lab command failed (${code}): ${stderr.trim() || 'no output'}`));
    });
    child.stdin.end(input ?? undefined);
  });
}
