import fs from 'node:fs';
import path from 'node:path';

import type { PersistedState } from './types.ts';

export const knownSteps = new Set([
  'activate-vaultwarden',
  'import-generated-accounts',
  'connect-radicale',
  'open-seafile',
  'open-immich',
  'open-stirling-pdf',
]);

export class OnboardingStateStore {
  private readonly stateDir: string;
  private readonly stateFilePath: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.stateFilePath = path.join(stateDir, 'onboarding-state.json');
  }

  getStateFilePath(): string {
    return this.stateFilePath;
  }

  load(): PersistedState {
    this.ensureStateDir();

    if (!fs.existsSync(this.stateFilePath)) {
      return {
        completedSteps: [],
        updatedAt: null,
      };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8')) as Partial<PersistedState>;
      const completedSteps = Array.isArray(parsed.completedSteps)
        ? parsed.completedSteps.filter((stepId): stepId is string => typeof stepId === 'string' && knownSteps.has(stepId))
        : [];

      return {
        completedSteps,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    } catch {
      return {
        completedSteps: [],
        updatedAt: null,
      };
    }
  }

  update(stepId: string, completed: boolean): PersistedState {
    const state = this.load();
    const nextSteps = new Set(state.completedSteps);

    if (completed) {
      nextSteps.add(stepId);
    } else {
      nextSteps.delete(stepId);
    }

    const nextState: PersistedState = {
      completedSteps: Array.from(nextSteps),
      updatedAt: new Date().toISOString(),
    };

    return this.save(nextState);
  }

  private ensureStateDir(): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  private save(nextState: PersistedState): PersistedState {
    this.ensureStateDir();
    fs.writeFileSync(this.stateFilePath, JSON.stringify(nextState, null, 2), 'utf8');
    return nextState;
  }
}
