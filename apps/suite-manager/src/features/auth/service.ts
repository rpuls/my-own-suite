import { createHash, timingSafeEqual } from 'node:crypto';

import type { SuiteManagerConfig } from '../../config.ts';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function matches(expected: string, actual: string): boolean {
  return timingSafeEqual(digest(expected), digest(actual));
}

export class AuthService {
  private readonly config: SuiteManagerConfig;

  constructor(config: SuiteManagerConfig) {
    this.config = config;
  }

  authenticate(email: string, password: string): boolean {
    return matches(this.config.ownerEmail, email.trim()) && matches(this.config.ownerPassword, password);
  }
}

