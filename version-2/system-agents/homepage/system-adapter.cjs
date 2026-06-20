const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CONFIG_ROOT = process.env.MOS_V2_HOMEPAGE_CONFIG_ROOT || '/var/lib/mos-v2/homepage/config';
const ROUTES_PATH = process.env.MOS_V2_HOMEPAGE_ROUTES_PATH || '/etc/caddy/mos-v2-homepage-routes.caddy';
const TRANSACTION_ROOT = process.env.MOS_V2_HOMEPAGE_TRANSACTION_ROOT || '/var/lib/mos-v2/homepage-agent/transactions';
const HISTORY_ROOT = process.env.MOS_V2_HOMEPAGE_HISTORY_ROOT || '/var/lib/mos-v2/homepage-agent/history';
const CADDY_BINARY = process.env.MOS_V2_CADDY_BINARY || '/usr/local/libexec/mos-v2/caddy';

function exec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120000 }, (error) => error ? reject(new Error('COMMAND_FAILED')) : resolve());
  });
}

async function atomicWrite(target, content, mode = 0o644) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, content, { mode });
  await fsp.chmod(temporary, mode);
  await fsp.rename(temporary, target);
}

async function snapshot(source, target) {
  if (fs.existsSync(source)) await fsp.copyFile(source, target);
  else await fsp.writeFile(`${target}.missing`, '');
}

async function restore(source, target) {
  if (fs.existsSync(`${source}.missing`)) await fsp.rm(target, { force: true });
  else await atomicWrite(target, await fsp.readFile(source));
}

class SystemHomepageAdapter {
  constructor({
    caddyBinary = CADDY_BINARY,
    configRoot = CONFIG_ROOT,
    execute = exec,
    historyRoot = HISTORY_ROOT,
    routesPath = ROUTES_PATH,
    transactionRoot = TRANSACTION_ROOT,
  } = {}) {
    this.caddyBinary = caddyBinary;
    this.configRoot = configRoot;
    this.execute = execute;
    this.historyRoot = historyRoot;
    this.routesPath = routesPath;
    this.transactionRoot = transactionRoot;
  }

  readHomepageFile(file) { return fsp.readFile(path.join(this.configRoot, file), 'utf8'); }

  async applyTransaction({ caddyRoutes, files, restartHomepage }) {
    const transactionId = `${Date.now()}-${process.pid}`;
    const transactionDir = path.join(this.transactionRoot, transactionId);
    const beforeDir = path.join(transactionDir, 'before');
    const stageDir = path.join(transactionDir, 'stage');
    await fsp.mkdir(beforeDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(stageDir, { recursive: true, mode: 0o700 });
    const changedFiles = [];
    let routesChanged = false;

    try {
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(this.configRoot, file);
        const current = fs.existsSync(target) ? await fsp.readFile(target, 'utf8') : null;
        await fsp.writeFile(path.join(stageDir, file), content);
        if (current !== content) {
          await snapshot(target, path.join(beforeDir, file));
          changedFiles.push(file);
        }
      }
      if (caddyRoutes !== null) {
        const current = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
        routesChanged = current !== caddyRoutes;
        await fsp.writeFile(path.join(stageDir, 'routes.caddy'), caddyRoutes);
        await this.execute(this.caddyBinary, ['validate', '--config', path.join(stageDir, 'routes.caddy')]);
        if (routesChanged) await snapshot(this.routesPath, path.join(beforeDir, 'routes.caddy'));
      }
      for (const file of changedFiles) await atomicWrite(path.join(this.configRoot, file), await fsp.readFile(path.join(stageDir, file)));
      if (routesChanged) await atomicWrite(this.routesPath, caddyRoutes);
      if (restartHomepage && changedFiles.length) await this.execute('/usr/bin/systemctl', ['restart', 'mos-v2-homepage.service']);
      if (routesChanged) await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service']);

      const historyDir = path.join(this.historyRoot, transactionId);
      await fsp.mkdir(historyDir, { recursive: true, mode: 0o700 });
      for (const file of changedFiles) await fsp.copyFile(path.join(beforeDir, file), path.join(historyDir, file)).catch(() => {});
      const history = (await fsp.readdir(this.historyRoot)).sort().reverse();
      await Promise.all(history.slice(10).map((name) => fsp.rm(path.join(this.historyRoot, name), { recursive: true, force: true })));
      await fsp.rm(transactionDir, { recursive: true, force: true });
      return { steps: ['staged', 'validated', 'written', ...(changedFiles.length ? ['homepage-restarted'] : []), ...(routesChanged ? ['caddy-reloaded'] : [])] };
    } catch {
      for (const file of changedFiles) await restore(path.join(beforeDir, file), path.join(this.configRoot, file)).catch(() => {});
      if (routesChanged) await restore(path.join(beforeDir, 'routes.caddy'), this.routesPath).catch(() => {});
      if (restartHomepage && changedFiles.length) await this.execute('/usr/bin/systemctl', ['restart', 'mos-v2-homepage.service']).catch(() => {});
      if (routesChanged) await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service']).catch(() => {});
      await fsp.rm(transactionDir, { recursive: true, force: true }).catch(() => {});
      throw new Error('HOMEPAGE_APPLY_FAILED');
    }
  }
}

module.exports = { SystemHomepageAdapter, atomicWrite };
