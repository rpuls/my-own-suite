// The AI gateway as an assistant meets it: a scripted MCP client connects with its
// own token over HTTPS, must be offered exactly the tools the app's ai-tools.json
// lets it use, and the app's own module calls them. Every offered tool has to be
// called, so a tool added to ai-tools.json without a check fails here first.
import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test } from '@playwright/test';

import { apiJson } from '../support/api.mjs';
import { requireAppModule } from '../support/catalog.mjs';
import { repoRoot } from '../support/env.mjs';
import { packageById, routeUrl } from '../support/packages.mjs';

const AI_API = '/suite-manager/api/settings/ai';
const OFFERED_KINDS = new Set(['read', 'add', 'change']);

const prefixOf = (id) => `${id.replace(/[^A-Za-z0-9]/gu, '_')}_`;
const kindOf = (entry) => (typeof entry === 'string' ? entry : entry?.kind);
const send = (method, body) => ({ body: body === undefined ? undefined : JSON.stringify(body), method });

function listedTools(id) {
  const file = path.join(repoRoot, 'apps', id, 'ai-tools.json');
  if (!fs.existsSync(file)) throw new Error(`apps/${id} has no ai-tools.json, so it offers an AI nothing to check.`);
  return Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).tools).map(([name, entry]) => ({ kind: kindOf(entry), name }));
}

function mcpClient(gateway, mcpUrl, token) {
  let id = 0;
  return async (method, params = {}) => {
    const response = await gateway.post(mcpUrl, { data: { id: ++id, jsonrpc: '2.0', method, params }, headers: { Authorization: `Bearer ${token}` } });
    expect(response.status(), `the AI gateway answers ${method}`).toBe(200);
    const message = await response.json();
    if (message.error) throw new Error(`The AI gateway refused ${method}: ${message.error.message}`);
    return message.result;
  };
}

// An app that keeps its own sign-in gets its token from the app's module, once.
async function giveSourceToken(ctx, id, module, source, gateway) {
  if (!source.token || source.token.configured) return;
  if (typeof module.aiToken !== 'function') throw new Error(`apps/${id}/e2e/index.mjs exports no aiToken(), and ${source.name} needs an access token from its owner.`);
  await test.step(`give MOS a ${source.name} access token`, async () => {
    const url = routeUrl(ctx.homeUrl, await packageById(ctx.page, id));
    const token = await module.aiToken({ env: ctx.env, request: gateway, state: ctx.state(id), url });
    await apiJson(ctx.page, `${AI_API}/sources/${encodeURIComponent(id)}/token`, send('PUT', { token }));
  });
}

function expectOffered(source, listed, prefix) {
  const changed = source.tools.filter((tool) => tool.review !== 'pinned').map((tool) => tool.name);
  if (changed.length) throw new Error(`These tools changed after the update and wait for the owner to accept them: ${changed.join(', ')}.`);
  const expected = listed.filter((tool) => OFFERED_KINDS.has(tool.kind)).map((tool) => `${prefix}${tool.name}`).sort();
  const found = source.tools.filter((tool) => OFFERED_KINDS.has(tool.kind)).map((tool) => tool.name).sort();
  expect(found, `${source.name} serves every tool its ai-tools.json offers`).toEqual(expected);
  return expected;
}

export async function ai(ctx, id) {
  const module = await requireAppModule(id);
  if (typeof module.ai !== 'function') throw new Error(`apps/${id}/e2e/index.mjs exports no ai(), and the app offers tools to an AI.`);
  const listed = listedTools(id);
  const prefix = prefixOf(id);
  let status = await apiJson(ctx.page, AI_API);
  if (!status.mcpUrl) throw new Error('The suite offers no MCP address: assistants connect only on an HTTPS address.');
  let source = status.sources.find((item) => item.id === id);
  if (!source) throw new Error(`${id} is installed without an mcp-server export, so MOS offers none of its tools.`);

  const gateway = await request.newContext({ ignoreHTTPSErrors: true });
  let client = null;
  try {
    await giveSourceToken(ctx, id, module, source, gateway);
    await test.step('connect a scripted assistant with See and do', async () => {
      client = await apiJson(ctx.page, `${AI_API}/clients`, send('POST', { name: `MOS E2E ${Date.now().toString(36)}`, preset: 'other' }));
      await apiJson(ctx.page, `${AI_API}/clients/${encodeURIComponent(client.client.id)}/levels/${encodeURIComponent(id)}`, send('PUT', { level: 'act' }));
    });
    status = await apiJson(ctx.page, AI_API);
    source = status.sources.find((item) => item.id === id);
    if (source.error) throw new Error(source.error);
    const offered = expectOffered(source, listed, prefix);
    const rpc = mcpClient(gateway, status.mcpUrl, client.token);

    await test.step('the assistant is offered exactly those tools', async () => {
      const started = await rpc('initialize', { capabilities: {}, clientInfo: { name: 'mos-e2e', version: '1' }, protocolVersion: '2025-11-25' });
      expect(started.serverInfo?.name).toBe('my-own-suite');
      const tools = (await rpc('tools/list')).tools.map((tool) => tool.name).filter((name) => name.startsWith(prefix)).sort();
      expect(tools).toEqual(offered);
    });

    await test.step('tools ai-tools.json never offers are refused before they reach the app', async () => {
      for (const tool of listed.filter((item) => !OFFERED_KINDS.has(item.kind))) {
        const result = await rpc('tools/call', { arguments: {}, name: `${prefix}${tool.name}` });
        expect(result.isError, `${tool.name} is ${tool.kind}`).toBe(true);
        expect(result.content?.[0]?.text).toContain('is not available to this AI');
      }
    });

    const called = new Set();
    const call = async (tool, args = {}) => {
      const result = await rpc('tools/call', { arguments: args, name: `${prefix}${tool}` });
      const text = (result.content || []).map((item) => item.text || '').join('\n');
      if (!result.isError) {
        called.add(`${prefix}${tool}`);
        expect(text, 'app output reaches the assistant marked as untrusted data').toContain('<untrusted-data');
      }
      return { isError: Boolean(result.isError), text };
    };
    await module.ai({ call, env: ctx.env, expect, state: ctx.state(id), step: (title, body) => test.step(title, body) });
    const uncalled = offered.filter((name) => !called.has(name));
    if (uncalled.length) throw new Error(`apps/${id}/e2e ai() never called ${uncalled.join(', ')} successfully: every tool ai-tools.json offers needs a check.`);
  } finally {
    if (client) await apiJson(ctx.page, `${AI_API}/clients/${encodeURIComponent(client.client.id)}`, send('DELETE')).catch(() => undefined);
    await gateway.dispose();
  }
}
