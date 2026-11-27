// "AI in your apps" as an owner sets it up: one AI service added in Settings and turned on
// for the app, which restarts it with the service's ${ai.*} values. The app's own module
// then makes the app ask the service something the way a user would, and the request has
// to arrive with the model and key the owner entered.
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { requireAppModule } from '../support/catalog.mjs';
import { DEFAULT_AI_SERVICE_PORT, runnerAddress, startFakeAiService } from '../support/fake-ai-service.mjs';
import { waitForRunning } from '../support/packages.mjs';
import { runAppHook } from './apps.mjs';

const API = '/suite-manager/api/settings/ai-services';
const ASKING_KINDS = new Set(['chat', 'completion', 'embedding']);

const send = (method, body) => ({ body: body === undefined ? undefined : JSON.stringify(body), method });

async function aiStatus(page) {
  return apiJson(page, API);
}

async function startService(ctx) {
  const address = ctx.env.read('MOS_E2E_RUNNER_ADDRESS') || await runnerAddress(ctx.homeUrl);
  const port = Number(ctx.env.read('MOS_E2E_AI_SERVICE_PORT', String(DEFAULT_AI_SERVICE_PORT)));
  const service = await startFakeAiService({ address, port });
  ctx.network?.ownerChosen.add(service.host);
  console.log(`[ai-service] fake AI service at ${service.baseUrl}`);
  return service;
}

function writeRequestLog(ctx, id, service) {
  const file = path.join(ctx.resultsDir, 'ai-service', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ baseUrl: service.baseUrl, models: service.models, requests: service.requests }, null, 2)}\n`);
}

// What the owner does to stop: the app's switch off, which restarts it without the service, and the service removed.
async function turnOff(ctx, id, serviceId) {
  await apiJson(ctx.page, `${API}/apps/${encodeURIComponent(id)}`, send('PUT', { serviceId: null }));
  const removed = await apiJson(ctx.page, `${API}/${encodeURIComponent(serviceId)}`, send('DELETE'));
  expect(removed.restartFailures, 'no app failed to restart when the service was removed').toEqual([]);
  expect(removed.status.services.some((item) => item.id === serviceId), 'the service is gone from Settings').toBe(false);
  expect(removed.status.apps.find((item) => item.packageId === id)?.serviceId ?? null, 'the app no longer uses a service').toBeNull();
  await waitForRunning(ctx.page, id);
}

export async function aiService(ctx, id) {
  const module = await requireAppModule(id);
  if (typeof module.aiService !== 'function') throw new Error(`apps/${id}/e2e/index.mjs exports no aiService(), and the app reads \${ai.*}.`);
  await ctx.page.goto(ctx.url('/suite-manager/'), { waitUntil: 'domcontentloaded' });
  const listed = (await aiStatus(ctx.page)).apps.find((item) => item.packageId === id);
  if (!listed) throw new Error(`Settings offers ${id} no AI service: it is not installed, or its manifest reads no \${ai.*}.`);

  const service = await startService(ctx);
  let serviceId = null;
  try {
    await test.step('add the AI service in Settings, which tests it', async () => {
      const added = await apiJson(ctx.page, API, send('POST', {
        apiKey: service.apiKey,
        baseUrl: service.baseUrl,
        embeddingModel: listed.readsSearchModel ? service.models.embedding : '',
        model: service.models.chat,
        name: 'MOS E2E model server',
      }));
      serviceId = added.status.services.find((item) => item.baseUrl === service.baseUrl)?.id || null;
      expect(serviceId, 'the service is listed in Settings').toBeTruthy();
      expect(added.test, 'Suite Manager reaches the service from the lab').toMatchObject({ ok: true });
    });

    await test.step(`turn it on for ${listed.name}, which restarts it`, async () => {
      const status = await apiJson(ctx.page, `${API}/apps/${encodeURIComponent(id)}`, send('PUT', { serviceId }));
      expect(status.apps.find((item) => item.packageId === id)?.serviceId).toBe(serviceId);
      await waitForRunning(ctx.page, id);
    });

    // Settings' own test ran before the switch, so everything from here on is the app's.
    const since = service.requests.length;
    const received = () => service.requests.slice(since);
    const ai = { model: service.models.chat, embeddingModel: listed.readsSearchModel ? service.models.embedding : null, received, reply: service.reply, serve: service.serve };
    await runAppHook(ctx, id, 'aiService', { ai });

    await test.step('the app asked the service with the model and key it was given', async () => {
      const configured = [ai.model, ai.embeddingModel].filter(Boolean);
      await expect.poll(() => received().filter((item) => ASKING_KINDS.has(item.kind)).length, { message: `${id} should send the AI service a request`, timeout: 60000 }).toBeGreaterThan(0);
      const asked = received().filter((item) => ASKING_KINDS.has(item.kind));
      expect(asked.filter((item) => !item.authorized).map((item) => item.path), 'every request carries the API key').toEqual([]);
      expect(asked.filter((item) => !configured.includes(item.model)).map((item) => item.model), `every request names a configured model (${configured.join(', ')})`).toEqual([]);
    });

    await test.step(`turn it off for ${listed.name} and remove the service`, () => turnOff(ctx, id, serviceId));
    serviceId = null;
  } finally {
    writeRequestLog(ctx, id, service);
    if (serviceId) await turnOff(ctx, id, serviceId).catch((error) => console.log(`[ai-service] cleaning up after ${id} failed: ${error.message}`));
    await service.close();
  }
}
