import { apiJson, expectSignedInApi } from '../support/api.mjs';
import { ensureOwnerSession } from '../support/auth.mjs';

// Signs in where the suite actually lives now. A lab can be on its own domain
// already (a run that continues one before it, a restore that brought the
// address back), and its apps answer only there.
export async function followAddress(ctx) {
  const { env, page } = ctx;
  let lastError = null;
  for (const candidate of [...new Set([ctx.homeUrl, env.baseURL])]) {
    try {
      await ensureOwnerSession(page, env, `${candidate}/suite-manager/`);
      const address = await apiJson(page, '/suite-manager/api/settings/address').catch(() => null);
      const applied = address?.lastChange?.status === 'applied' ? address.address?.url?.replace(/\/$/u, '') : null;
      ctx.homeUrl = applied || env.baseURL;
      if (ctx.homeUrl !== candidate) await ensureOwnerSession(page, env, ctx.url('/suite-manager/'));
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function owner(ctx) {
  await followAddress(ctx);
  await expectSignedInApi(ctx.page, ctx.url('/suite-manager/'));
}
