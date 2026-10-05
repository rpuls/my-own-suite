async function homepageBodyText(page, homeUrl) {
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
  return page.locator('body').innerText().catch(() => '');
}

export async function waitForHomepageAvailable(page, homeUrl) {
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await homepageBodyText(page, homeUrl);
    if (!lastText.includes('Homepage is unavailable.')) return;
    await page.waitForTimeout(3000);
  }
  throw new Error(`Homepage did not become available at ${homeUrl}. Last response body: ${lastText.slice(0, 300)}`);
}

export async function waitForHomepageText(page, text, homeUrl) {
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await homepageBodyText(page, homeUrl);
    if (lastText.includes(text)) return;
    await page.waitForTimeout(3000);
  }
  throw new Error(`Homepage did not render "${text}" at ${homeUrl}. Last response body: ${lastText.slice(0, 300)}`);
}
