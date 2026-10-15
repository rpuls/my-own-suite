// ONLYOFFICE's own end-to-end journey for the MOS E2E suite (test/e2e). Not
// package content: a package's e2e/ folder never ships and never changes its digest.
// Editing happens inside the apps it is connected to, so their journeys exercise it and
// screenshot the editor; its own page is only a welcome screen, not worth comparing.
import { expect } from '@playwright/test';

// The welcome page is served before the document service behind it has started.
async function documentServerAnswers(page, url) {
  const health = new URL('/healthcheck', url).toString();
  await expect.poll(async () => {
    const response = await page.request.get(health);
    return response.status() === 200 ? (await response.text()).trim() : `HTTP ${response.status()}`;
  }, { intervals: [5000], message: 'the document server should report itself healthy', timeout: 180000 }).toBe('true');
  await expect(page.getByRole('heading', { name: /ONLYOFFICE Docs .* installed/iu })).toBeVisible({ timeout: 60000 });
}

export default {
  async landed({ page }) {
    await expect(page.locator('body')).toContainText(/ONLYOFFICE/iu, { timeout: 120000 });
  },

  async journey({ page, url }) {
    await documentServerAnswers(page, url);
  },

  async verify({ page, url }) {
    await documentServerAnswers(page, url);
  },
};
