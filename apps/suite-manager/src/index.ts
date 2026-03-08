import axios from 'axios';
import http from 'node:http';
import process from 'node:process';

const port = Number(process.env.PORT) || 3000;
const checkIntervalMs = Number(process.env.SUITE_MANAGER_CHECK_INTERVAL_MS) || 5 * 60 * 1000;
const homepageUrl = process.env.HOMEPAGE_URL || 'http://homepage:3000/';
const requestTimeoutMs = Number(process.env.SUITE_MANAGER_REQUEST_TIMEOUT_MS) || 10_000;
const runOnce = process.env.SUITE_MANAGER_RUN_ONCE === 'true';

function log(message: string): void {
  console.log(`[suite-manager] ${new Date().toISOString()} ${message}`);
}

async function checkAppStatus(name: string, url: string): Promise<void> {
  try {
    const response = await axios.get(url, {
      timeout: requestTimeoutMs,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (response.status >= 200 && response.status < 300) {
      log(`${name} check OK (${response.status}) ${url}`);
      return;
    }

    log(`${name} check FAILED (${response.status}) ${url}`);
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.message : String(error);
    log(`${name} check ERROR (${url}): ${message}`);
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      service: 'suite-manager',
      status: 'ok',
      homepageUrl,
      checkIntervalMs,
    }),
  );
});

server.listen(port, () => {
  log(`Suite Manager listening on port ${port}`);
  log(`Homepage target ${homepageUrl}`);
  log(`Homepage check interval ${checkIntervalMs}ms`);
});

let interval: NodeJS.Timeout | undefined;

void (async () => {
  await checkAppStatus('Homepage', homepageUrl);

  if (runOnce) {
    log('SUITE_MANAGER_RUN_ONCE enabled, exiting after initial check');
    server.close(() => process.exit());
    return;
  }

  interval = setInterval(() => {
    void checkAppStatus('Homepage', homepageUrl);
  }, checkIntervalMs);
})();

function shutdown(signal: string): void {
  log(`Received ${signal}, shutting down`);
  if (interval) {
    clearInterval(interval);
  }
  server.close((error) => {
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`HTTP server close error: ${message}`);
      process.exitCode = 1;
    }
    process.exit();
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
