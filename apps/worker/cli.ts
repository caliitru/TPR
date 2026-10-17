import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { database } from '../../packages/db/client.js';
import { seed } from '../../packages/db/seed.js';
import { migrate } from '../../packages/db/migrate.js';
import { ingest, processNext } from '../../packages/core/pipeline.js';
import {
  review,
  suppress,
  type Actor,
} from '../../packages/core/moderation.js';
import {
  exportLocal,
  retractions,
  type ExportType,
} from '../../packages/adapters/export.js';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    action: { type: 'string' },
    reason: { type: 'string' },
    reviewer: { type: 'string' },
    key: { type: 'string' },
    source: { type: 'string' },
    item: { type: 'string' },
    type: { type: 'string' },
    'authorize-local-export': { type: 'boolean' },
    out: { type: 'string' },
  },
});
const db = database();
const actor: Actor = { id: values.reviewer ?? 'local-operator', role: 'admin' };
try {
  let result: unknown;
  switch (positionals[0]) {
    case 'migrate':
      await migrate(db);
      result = { migrated: true };
      break;
    case 'seed':
      result = await seed(db);
      break;
    case 'ingest':
      result = await ingest(db, values.key ?? randomUUID());
      break;
    case 'work':
      while (await processNext(db)) {
        /* drain due jobs */
      }
      result = (
        await db.pool.query(
          'SELECT job_id,state,attempts,error_code FROM crawl_jobs ORDER BY queued_at',
        )
      ).rows;
      break;
    case 'list':
      result = (
        await db.pool.query(
          'SELECT payload FROM observations ORDER BY observation_id',
        )
      ).rows.map((r) => r.payload as unknown);
      break;
    case 'jobs':
      result = (
        await db.pool.query(
          'SELECT job_id,source_id,state,attempts,error_code,external_cursor FROM crawl_jobs ORDER BY queued_at',
        )
      ).rows;
      break;
    case 'review':
      if (!values.reviewer)
        throw new Error('--reviewer is required for audit attribution');
      result = await review(
        db,
        z.uuid().parse(values.id),
        {
          action: z.enum(['approve', 'reject', 'revoke']).parse(values.action),
          reason: z
            .enum([
              'verified_fixture',
              'insufficient_evidence',
              'ambiguous_product',
              'rights_concern',
              'sponsored',
              'duplicate',
              'takedown',
              'correction',
            ])
            .parse(values.reason),
          idempotency_key: values.key ?? randomUUID(),
        },
        actor,
      );
      break;
    case 'export':
      if (!values.reviewer)
        throw new Error('--reviewer is required for batch authorization');
      result = await exportLocal(db, {
        actor,
        authorizeLocalExport: values['authorize-local-export'] === true,
        type: (values.type ?? 'analysis_observations') as ExportType,
        directory: values.out,
      });
      break;
    case 'suppress':
      if (!values.reviewer) throw new Error('--reviewer is required');
      result = await suppress(
        db,
        { source_id: values.source, item_id: values.item },
        values.reason ?? 'takedown',
        actor,
      );
      break;
    case 'retractions':
      result = await retractions(db);
      break;
    default:
      throw new Error(
        'Commands: migrate, seed, ingest, work, list, jobs, review, export, suppress, retractions',
      );
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exitCode = 1;
} finally {
  await db.pool.end();
}
