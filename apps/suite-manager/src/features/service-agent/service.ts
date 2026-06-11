import type { SuiteManagerConfig } from '../../config.ts';
import {
  applyAgentAppCatalogComposeSelection,
  applyAgentCaddyExternalProxies,
  applyAgentLocalHttps,
  readServiceAgentStatus,
  restartAgentService,
} from './agent.ts';

export type ServiceCapabilityStatus = {
  caddyExternalProxyApplyAvailable: boolean;
  error: string | null;
  appCatalogComposeSelectionApplyAvailable: boolean;
  homepageRestartAvailable: boolean;
  localHttpsApplyAvailable: boolean;
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
        appCatalogComposeSelectionApplyAvailable: false,
        caddyExternalProxyApplyAvailable: false,
        error: null,
        homepageRestartAvailable: false,
        localHttpsApplyAvailable: false,
        serviceAvailable: false,
      };
    }

    try {
      const status = await readServiceAgentStatus(this.config);
      const homepageCapabilities = status.capabilities?.homepage?.capabilities || [];
      const caddyCapabilities = status.capabilities?.caddy?.capabilities || [];
      const settingsCapabilities = status.capabilities?.settings?.capabilities || [];
      const appCatalogCapabilities = status.capabilities?.['app-catalog']?.capabilities || [];

      return {
        appCatalogComposeSelectionApplyAvailable: appCatalogCapabilities.includes('compose-selection.apply'),
        caddyExternalProxyApplyAvailable: caddyCapabilities.includes('external-proxies.apply'),
        error: null,
        homepageRestartAvailable: homepageCapabilities.includes('restart'),
        localHttpsApplyAvailable: settingsCapabilities.includes('local-https.apply'),
        serviceAvailable: true,
      };
    } catch (caughtError) {
      return {
        appCatalogComposeSelectionApplyAvailable: false,
        caddyExternalProxyApplyAvailable: false,
        error: caughtError instanceof Error ? caughtError.message : 'Service agent is unavailable.',
        homepageRestartAvailable: false,
        localHttpsApplyAvailable: false,
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

  async applyCaddyExternalProxies(caddyfile: string): Promise<{ applied: boolean }> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.caddyExternalProxyApplyAvailable) {
      throw new Error('Caddy external proxy apply service is unavailable.');
    }

    await applyAgentCaddyExternalProxies(this.config, caddyfile);
    return { applied: true };
  }

  async applyLocalHttps(input: {
    acmeEmail: string;
    cloudflareApiToken: string;
    domain: string;
  }): Promise<{ applied: boolean; domain?: string; restartScheduled?: boolean }> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.localHttpsApplyAvailable) {
      throw new Error('Local HTTPS apply service is unavailable.');
    }

    const result = await applyAgentLocalHttps(this.config, input);
    return { applied: true, domain: result.domain, restartScheduled: result.restartScheduled };
  }

  async applyAppCatalogComposeSelection(input: {
    composeYaml: string;
    selectionJson: string;
  }): Promise<{ applied: boolean }> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.appCatalogComposeSelectionApplyAvailable) {
      throw new Error('App catalog Compose selection apply service is unavailable.');
    }

    await applyAgentAppCatalogComposeSelection(this.config, input);
    return { applied: true };
  }
}
