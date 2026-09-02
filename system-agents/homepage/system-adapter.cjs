const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { describeFailure, indent, runCommand } = require('../lib/command-output.cjs');

const CONFIG_ROOT = process.env.MOS_HOMEPAGE_CONFIG_ROOT || '/var/lib/mos/homepage/config';
const ROUTES_PATH = process.env.MOS_HOMEPAGE_ROUTES_PATH || '/etc/caddy/mos-homepage-routes.caddy';
const TRANSACTION_ROOT = process.env.MOS_HOMEPAGE_TRANSACTION_ROOT || '/var/lib/mos/homepage-agent/transactions';
const HISTORY_ROOT = process.env.MOS_HOMEPAGE_HISTORY_ROOT || '/var/lib/mos/homepage-agent/history';
const CADDY_BINARY = process.env.MOS_CADDY_BINARY || '/usr/local/libexec/mos/caddy';
const SYSTEMCTL_BINARY = '/usr/bin/systemctl';
const JOURNALCTL_BINARY = '/usr/bin/journalctl';
const HOMEPAGE_RESTART_TIMEOUT_MS = 60_000;
const UNIT_LOG_LINES = 40;

// Per stage: the code and sentence a failure reports, and the caller's label
// for the command that stage runs, since the argv is never part of a report.
const FAILURE_MESSAGES = {
  'caddy-validation': ['HOMEPAGE_CADDY_VALIDATION_FAILED', 'The generated home-service routes did not pass Caddy validation.', 'caddy validate for the home-service routes'],
  'caddy-reload': ['HOMEPAGE_CADDY_RELOAD_FAILED', 'Caddy could not reload the generated home-service routes.', 'systemctl reload caddy.service'],
  'homepage-restart': ['HOMEPAGE_RESTART_FAILED', 'Homepage did not restart successfully.', 'systemctl restart mos-homepage.service'],
  history: ['HOMEPAGE_HISTORY_FAILED', 'The previous Homepage configuration could not be retained safely.', 'Retaining the previous configuration'],
  staging: ['HOMEPAGE_STAGING_FAILED', 'Homepage configuration could not be staged.', 'Staging the configuration'],
  writing: ['HOMEPAGE_WRITE_FAILED', 'Homepage configuration could not be installed.', 'Writing the configuration'],
};

class HomepageApplyError extends Error {
  constructor(stage, details = []) {
    const [code, message] = FAILURE_MESSAGES[stage] || ['HOMEPAGE_APPLY_FAILED', 'The Homepage operation failed.'];
    super(message);
    this.code = code;
    this.details = details;
    this.statusCode = 502;
  }
}

function exec(file, args, { timeoutMs = 20000 } = {}) {
  return runCommand(file, args, { timeoutMs });
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

  // systemctl only says that a unit failed; the unit's own log says why.
  async unitLog(unit) {
    try {
      const { stdout } = await this.execute(JOURNALCTL_BINARY, ['-u', unit, '-n', String(UNIT_LOG_LINES), '--no-pager', '-o', 'cat']);
      return String(stdout || '').trim();
    } catch {
      return '';
    }
  }

  async explain(stage, error) {
    const details = describeFailure(error, FAILURE_MESSAGES[stage]?.[2] || 'The step');
    const unit = stage === 'homepage-restart' ? 'mos-homepage.service' : stage === 'caddy-reload' ? 'caddy.service' : null;
    const log = unit ? await this.unitLog(unit) : '';
    if (log) details.push(`Last lines of ${unit}:\n${indent(log)}`);
    return new HomepageApplyError(stage, details);
  }

  async applyTransaction({ caddyRoutes, files, restartHomepage }) {
    const transactionId = `${Date.now()}-${process.pid}`;
    const transactionDir = path.join(this.transactionRoot, transactionId);
    const beforeDir = path.join(transactionDir, 'before');
    const stageDir = path.join(transactionDir, 'stage');
    await fsp.mkdir(beforeDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(stageDir, { recursive: true, mode: 0o700 });
    const changedFiles = [];
    let routesChanged = false;
    let stage = 'staging';

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
        if (routesChanged) {
          stage = 'caddy-validation';
          await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', path.join(stageDir, 'routes.caddy')]);
          await snapshot(this.routesPath, path.join(beforeDir, 'routes.caddy'));
        }
      }
      stage = 'writing';
      for (const file of changedFiles) await atomicWrite(path.join(this.configRoot, file), await fsp.readFile(path.join(stageDir, file)));
      if (routesChanged) await atomicWrite(this.routesPath, caddyRoutes);
      if (restartHomepage && changedFiles.length) {
        stage = 'homepage-restart';
        await this.execute(SYSTEMCTL_BINARY, ['restart', 'mos-homepage.service'], { timeoutMs: HOMEPAGE_RESTART_TIMEOUT_MS });
      }
      if (routesChanged) {
        stage = 'caddy-reload';
        await this.execute(SYSTEMCTL_BINARY, ['reload', 'caddy.service']);
      }

      stage = 'history';
      const historyDir = path.join(this.historyRoot, transactionId);
      await fsp.mkdir(historyDir, { recursive: true, mode: 0o700 });
      for (const file of changedFiles) await fsp.copyFile(path.join(beforeDir, file), path.join(historyDir, file)).catch(() => {});
      const history = (await fsp.readdir(this.historyRoot)).sort().reverse();
      await Promise.all(history.slice(10).map((name) => fsp.rm(path.join(this.historyRoot, name), { recursive: true, force: true })));
      await fsp.rm(transactionDir, { recursive: true, force: true });
      return { steps: ['staged', 'validated', 'written', ...(changedFiles.length ? ['homepage-restarted'] : []), ...(routesChanged ? ['caddy-reloaded'] : [])] };
    } catch (caught) {
      // Explained before the rollback restarts the units, while the unit log
      // still ends with the failure rather than with the recovery.
      const error = await this.explain(stage, caught);
      for (const file of changedFiles) await restore(path.join(beforeDir, file), path.join(this.configRoot, file)).catch(() => {});
      if (routesChanged) await restore(path.join(beforeDir, 'routes.caddy'), this.routesPath).catch(() => {});
      if (restartHomepage && changedFiles.length) await this.execute(SYSTEMCTL_BINARY, ['restart', 'mos-homepage.service'], { timeoutMs: 10000 }).catch(() => {});
      if (routesChanged) await this.execute(SYSTEMCTL_BINARY, ['reload', 'caddy.service'], { timeoutMs: 10000 }).catch(() => {});
      await fsp.rm(transactionDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = { HOMEPAGE_RESTART_TIMEOUT_MS, HomepageApplyError, SystemHomepageAdapter, atomicWrite };
