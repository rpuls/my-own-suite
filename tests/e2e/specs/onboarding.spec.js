import { expect, test } from '@playwright/test';

import { completeOnboarding } from '../support/onboarding.js';

test.describe('suite-manager onboarding against the real local stack', () => {
  test('signs in, creates the Vaultwarden owner account, imports credentials, and reaches Homepage', async ({ context, page }) => {
    await completeOnboarding(context, page);
    await expect(page.locator('body')).toContainText('My Own Suite');
    await expect(page.getByRole('link', { name: /Suite Manager/i })).toBeVisible();
  });
});
