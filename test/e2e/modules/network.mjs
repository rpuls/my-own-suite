import path from 'node:path';

import { writeNetworkReport } from '../support/network.mjs';

// The capture itself runs from the first step of any path that holds this one.
export async function network(ctx) {
  const { apps, problems } = await writeNetworkReport(ctx);
  const report = path.relative(process.cwd(), path.join(ctx.network.dir, 'report.md'));
  for (const app of apps) {
    const hosts = app.destinations.map((item) => `${item.host} (${item.channel}${item.expected === false ? ', unexpected' : ''})`);
    console.log(`[network] ${app.id}: ${hosts.length ? hosts.join(', ') : 'nothing'}`);
  }
  if (problems.length) throw new Error(`The network capture found ${problems.length} problem${problems.length === 1 ? '' : 's'} (${report}):\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
}
