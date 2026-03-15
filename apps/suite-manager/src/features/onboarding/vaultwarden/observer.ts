import { Client } from 'pg';

import { log } from '../../../lib/logger.ts';

export type VaultwardenAccountStatus = 'pending' | 'ready' | 'unavailable';

export type VaultwardenObservation = {
  cipherCount: number | null;
  message?: string;
  source: 'database' | 'none';
  status: VaultwardenAccountStatus;
  userId: string | null;
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
        cipherCount: null,
        message: 'Vaultwarden account detection is not configured.',
        source: 'none',
        status: 'unavailable',
        userId: null,
      };
    }

    const client = new Client({
      connectionString: this.databaseUrl,
    });

    try {
      await client.connect();
      const result = await client.query<{ _uuid: string }>(
        'select uuid as _uuid from users where lower(email) = lower($1) limit 1',
        [this.ownerEmail],
      );

      if (!result.rowCount || result.rowCount < 1) {
        return {
          cipherCount: null,
          source: 'database',
          status: 'pending',
          userId: null,
        };
      }

      const userId = result.rows[0]?._uuid ?? null;
      const cipherResult = await client.query<{ count: string }>(
        'select count(*)::text as count from ciphers where user_uuid = $1',
        [userId],
      );
      const cipherCount = Number(cipherResult.rows[0]?.count ?? '0');

      return {
        cipherCount: Number.isFinite(cipherCount) ? cipherCount : 0,
        source: 'database',
        status: 'ready',
        userId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Vaultwarden account detection failed: ${message}`);

      return {
        cipherCount: null,
        message: 'Vaultwarden account detection is temporarily unavailable.',
        source: 'database',
        status: 'unavailable',
        userId: null,
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}
