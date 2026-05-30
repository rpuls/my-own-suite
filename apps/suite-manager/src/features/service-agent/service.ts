import type { SuiteManagerConfig } from '../../config.ts';
import { readServiceAgentStatus, restartAgentService } from './agent.ts';

export type ServiceCapabilityStatus = {
  error: string | null;
  homepageRestartAvailable: boolean;
  serviceAvailable: boolean;
};

export class ServiceAgentService {
  private readonly config: SuiteManagerConfig;

  constructor(config: SuiteManagerConfig) {
    this.config = config;
  }

  async getCapabilities(): Promise<ServiceCapabilityStatus> {
    if (!this.config.serviceAgent.socketPath || !this.config.serviceAgent.tokenFile) {
      return {
        error: null,
        homepageRestartAvailable: false,
        serviceAvailable: false,
      };
    }

    try {
      const status = await readServiceAgentStatus(this.config);
      const homepageCapabilities = status.capabilities?.homepage?.capabilities || [];

      return {
        error: null,
        homepageRestartAvailable: homepageCapabilities.includes('restart'),
        serviceAvailable: true,
      };
    } catch (caughtError) {
      return {
        error: caughtError instanceof Error ? caughtError.message : 'Service agent is unavailable.',
        homepageRestartAvailable: false,
        serviceAvailable: false,
      };
    }
  }

  async restartHomepage(): Promise<{ restarted: boolean }> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.homepageRestartAvailable) {
      throw new Error('Homepage restart service is unavailable.');
    }

    await restartAgentService(this.config, 'homepage');
    return { restarted: true };
  }
}
