import { Client } from 'pg';

import { log } from '../../lib/logger.ts';

export type VaultwardenAccountStatus = 'pending' | 'ready' | 'unavailable';

export type VaultwardenObservation = {
  message?: string;
  source: 'database' | 'none';
  status: VaultwardenAccountStatus;
};

export class VaultwardenObserver {
  private readonly databaseUrl: string;
  private readonly ownerEmail: string;

  constructor(databaseUrl: string, ownerEmail: string) {
    this.databaseUrl = databaseUrl;
    this.ownerEmail = ownerEmail;
  }

  async getAccountStatus(): Promise<VaultwardenObservation> {
    if (!this.databaseUrl) {
      return {
        message: 'Vaultwarden account detection is not configured.',
        source: 'none',
        status: 'unavailable',
      };
    }

    const client = new Client({
      connectionString: this.databaseUrl,
    });

    try {
      await client.connect();
      const result = await client.query<{ email: string }>(
        'select email from users where lower(email) = lower($1) limit 1',
        [this.ownerEmail],
      );

      return {
        source: 'database',
        status: result.rowCount && result.rowCount > 0 ? 'ready' : 'pending',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Vaultwarden account detection failed: ${message}`);

      return {
        message: 'Vaultwarden account detection is temporarily unavailable.',
        source: 'database',
        status: 'unavailable',
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
