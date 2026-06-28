const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const APPS_ROOT = process.env.MOS_V2_APPS_ROOT || path.resolve(process.cwd(), 'apps');
const APP_ROUTES_PATH = process.env.MOS_V2_APP_ROUTES_PATH || '/etc/caddy/mos-v2-app-routes.caddy';
const CADDY_BINARY = process.env.MOS_V2_CADDY_BINARY || '/usr/local/libexec/mos-v2/caddy';
const DOCKER_BINARY = process.env.MOS_V2_DOCKER_BINARY || '/usr/bin/docker';
const HEALTH_TIMEOUT_MS = 90_000;

const FAILURE_MESSAGES = {
  build: ['APP_BUILD_FAILED', 'The app image could not be built.'],
  'caddy-reload': ['APP_CADDY_RELOAD_FAILED', 'Caddy could not reload the app route.'],
  'caddy-validation': ['APP_CADDY_VALIDATION_FAILED', 'The generated app route did not pass Caddy validation.'],
  health: ['APP_HEALTH_FAILED', 'The app container started but did not become healthy in time.'],
  run: ['APP_RUN_FAILED', 'The app container could not be started.'],
  writing: ['APP_ROUTE_WRITE_FAILED', 'The app route could not be installed.'],
};

class AppApplyError extends Error {
  constructor(stage) {
    const [code, message] = FAILURE_MESSAGES[stage] || ['APP_RUNTIME_APPLY_FAILED', 'The app runtime operation failed.'];
    super(message);
    this.code = code;
    this.statusCode = 502;
  }
}

function exec(file, args, { cwd = undefined, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: timeoutMs }, (error) => error ? reject(new Error('COMMAND_FAILED')) : resolve());
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
  else await atomicWrite(target, await fsp.readFile(source, 'utf8'));
}

function waitForHttp(url, { deadlineMs = HEALTH_TIMEOUT_MS } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, { timeout: 3000 }, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      request.on('timeout', () => request.destroy(new Error('TIMEOUT')));
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started >= deadlineMs) {
        reject(new Error('HEALTH_TIMEOUT'));
        return;
      }
      setTimeout(attempt, 1500);
    };
    attempt();
  });
}

class SystemAppAdapter {
  constructor({
    appsRoot = APPS_ROOT,
    caddyBinary = CADDY_BINARY,
    dockerBinary = DOCKER_BINARY,
    execute = exec,
    routesPath = APP_ROUTES_PATH,
    waitForReady = waitForHttp,
  } = {}) {
    this.appsRoot = appsRoot;
    this.caddyBinary = caddyBinary;
    this.dockerBinary = dockerBinary;
    this.execute = execute;
    this.routesPath = routesPath;
    this.waitForReady = waitForReady;
  }

  async applyAppService({ caddyRoutes, dockerfile, healthTarget, imageTag, internalPort, loopbackPort, packageId, publicUrl, volumes }) {
    const packageDir = path.join(this.appsRoot, packageId);
    const routeSnapshot = `${this.routesPath}.before-${process.pid}`;
    let routesChanged = false;
    let stage = 'build';

    try {
      await this.execute(this.dockerBinary, ['build', '--file', dockerfile, '--tag', imageTag, '.'], { cwd: packageDir, timeoutMs: 300000 });

      stage = 'run';
      await this.execute(this.dockerBinary, ['rm', '-f', `mos-v2-app-${packageId}`], { timeoutMs: 30000 }).catch(() => {});
      const volumeArgs = [];
      for (const volume of volumes || []) {
        const separator = String(volume).indexOf(':');
        if (separator > 0) {
          volumeArgs.push('--volume', `mos-v2-app-${packageId}-${String(volume).slice(0, separator)}:${String(volume).slice(separator + 1)}`);
        }
      }
      await this.execute(this.dockerBinary, [
        'run',
        '--detach',
        '--name', `mos-v2-app-${packageId}`,
        '--restart', 'unless-stopped',
        '--publish', `127.0.0.1:${loopbackPort}:${internalPort}`,
        '--env', `SERVER_HOST=${publicUrl}`,
        ...volumeArgs,
        imageTag,
      ], { timeoutMs: 60000 });

      stage = 'health';
      await this.waitForReady(healthTarget);

      const currentRoutes = fs.existsSync(this.routesPath) ? await fsp.readFile(this.routesPath, 'utf8') : null;
      routesChanged = currentRoutes !== caddyRoutes;
      if (routesChanged) {
        stage = 'caddy-validation';
        const candidate = `${this.routesPath}.candidate-${process.pid}`;
        await fsp.writeFile(candidate, caddyRoutes);
        await this.execute(this.caddyBinary, ['validate', '--adapter', 'caddyfile', '--config', candidate], { timeoutMs: 20000 });
        await fsp.rm(candidate, { force: true }).catch(() => {});
        await snapshot(this.routesPath, routeSnapshot);

        stage = 'writing';
        await atomicWrite(this.routesPath, caddyRoutes);

        stage = 'caddy-reload';
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 20000 });
        await fsp.rm(routeSnapshot, { force: true }).catch(() => {});
        await fsp.rm(`${routeSnapshot}.missing`, { force: true }).catch(() => {});
      }

      return { steps: ['built', 'started', 'healthy', ...(routesChanged ? ['route-written', 'caddy-reloaded'] : [])] };
    } catch {
      if (routesChanged) {
        await restore(routeSnapshot, this.routesPath).catch(() => {});
        await this.execute('/usr/bin/systemctl', ['reload', 'caddy.service'], { timeoutMs: 10000 }).catch(() => {});
      }
      throw new AppApplyError(stage);
    }
  }
}

module.exports = { APP_ROUTES_PATH, AppApplyError, HEALTH_TIMEOUT_MS, SystemAppAdapter, atomicWrite, waitForHttp };
