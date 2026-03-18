import axios from 'axios';

import { log } from '../../lib/logger.ts';

export class HomepageHealthMonitor {
  private readonly checkIntervalMs: number;
  private readonly homepageUrl: string;
  private interval: NodeJS.Timeout | undefined;
  private readonly requestTimeoutMs: number;

  constructor(homepageUrl: string, requestTimeoutMs: number, checkIntervalMs: number) {
    this.homepageUrl = homepageUrl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.checkIntervalMs = checkIntervalMs;
  }

  async runCheck(name = 'Homepage'): Promise<void> {
    try {
      const response = await axios.get(this.homepageUrl, {
        timeout: this.requestTimeoutMs,
        maxRedirects: 5,
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
        log(`${name} check OK (${response.status}) ${this.homepageUrl}`);
        return;
      }

      log(`${name} check FAILED (${response.status}) ${this.homepageUrl}`);
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.message : String(error);
      log(`${name} check ERROR (${this.homepageUrl}): ${message}`);
    }
  }

  start(): void {
    this.interval = setInterval(() => {
      void this.runCheck();
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }
}
