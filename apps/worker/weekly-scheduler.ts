import type { RegistrySource } from '../../packages/contracts/sources.js';
import { setTimeout } from 'node:timers/promises';
import { database } from '../../packages/db/client.js';
import { weeklyTick } from '../../packages/core/weekly.js';
import { mockTransportFor } from '../../packages/connectors/mock-scenarios.js';
if (process.env.TPR_WEEKLY_SCHEDULER_ENABLED !== 'true')
  throw new Error(
    'Scheduler is disabled; explicit local operator authorization is required',
  );
const db = database(),
  controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => controller.abort());
try {
  while (!controller.signal.aborted) {
    try {
      const report = await weeklyTick(db, {
        actor: { id: 'local-weekly-mock-scheduler', role: 'admin' },
        transportForSource: async (id) => {
          const row = (
            await db.pool.query<{ type: RegistrySource['type'] }>(
              'SELECT type FROM sources WHERE source_id=$1',
              [id],
            )
          ).rows[0]!;
          return mockTransportFor(row.type);
        },
      });
      if (!('state' in report && report.state === 'not_due'))
        process.stdout.write(JSON.stringify(report) + '\n');
    } catch {
      process.stderr.write(
        'Weekly mock scheduler tick failed; retrying on next tick\n',
      );
    }
    try {
      await setTimeout(60000, undefined, { signal: controller.signal });
    } catch {
      break;
    }
  }
} finally {
  await db.pool.end();
}
