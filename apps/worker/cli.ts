import { assessSources } from '../../packages/core/source-assessment.js';
import { researchPolicy } from '../../packages/core/policy-research.js';
import { runWeekly } from '../../packages/core/weekly.js';
import { seedSourceCatalog } from '../../packages/db/source-catalog.js';
import { readFile } from 'node:fs/promises';
import {
  registerSource,
  approveSourcePolicy,
  enableMockSource,
  suspendSource,
  sourceHealth,
} from '../../packages/core/sources.js';
import { collectSource } from '../../packages/core/collection.js';
import { mockTransportFor } from '../../packages/connectors/mock-scenarios.js';
import {
  purgeExpiredMetadata,
  correctProductMatch,
} from '../../packages/core/operations.js';
import type { RegistrySource } from '../../packages/contracts/sources.js';
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
    file: { type: 'string' },
    force: { type: 'boolean' },
    until: { type: 'string' },
    'authorize-backfill': { type: 'boolean' },
    'authorize-policy-research': { type: 'boolean' },
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

    case 'source-assess':
      if (!values['authorize-policy-research'])
        throw new Error(
          '--authorize-policy-research is required; this command performs real policy-navigation requests, not content collection',
        );
      result = await assessSources(db, {
        actor,
        fetchPolicy: researchPolicy,
        youtubeCredentialPresent: Boolean(process.env.TPR_YOUTUBE_API_KEY),
        redditCredentialsPresent: Boolean(
          process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET,
        ),
      });
      break;
    case 'source-assessments':
      result = (
        await db.pool.query(
          'SELECT * FROM source_assessment_runs ORDER BY created_at DESC LIMIT 10',
        )
      ).rows;
      break;
    case 'weekly-mock':
    case 'backfill-mock':
      if (positionals[0] === 'backfill-mock' && !values['authorize-backfill'])
        throw new Error(
          '--authorize-backfill is required for the separate five-year mock backfill',
        );
      result = await runWeekly(db, {
        actor,
        kind: positionals[0] === 'backfill-mock' ? 'backfill' : 'weekly',
        ...(values.until
          ? {
              end: new Date(
                z.iso.datetime({ offset: true }).parse(values.until),
              ),
            }
          : {}),
        ...(values.source ? { sourceIds: [values.source] } : {}),
        transportForSource: async (id) =>
          mockTransportFor(
            (
              await db.pool.query<{ type: RegistrySource['type'] }>(
                'SELECT type FROM sources WHERE source_id=$1',
                [id],
              )
            ).rows[0]!.type,
          ),
      });
      break;
    case 'weekly-reports':
      result = (
        await db.pool.query(
          'SELECT * FROM weekly_reports ORDER BY created_at DESC LIMIT 25',
        )
      ).rows;
      break;
    case 'registry-seed':
      result = await seedSourceCatalog(db, actor);
      break;
    case 'sources':
      result = await sourceHealth(db);
      break;
    case 'source-add':
    case 'source-update':
      if (!values.file) throw new Error('--file source.json is required');
      result = await registerSource(
        db,
        JSON.parse(await readFile(values.file, 'utf8')),
        actor,
        positionals[0] === 'source-update',
      );
      break;
    case 'source-policy':
      if (!values.file || !values.source)
        throw new Error('--source and --file policy.json required');
      result = await approveSourcePolicy(
        db,
        values.source,
        JSON.parse(await readFile(values.file, 'utf8')),
        actor,
      );
      break;
    case 'source-enable-mock':
      result = await enableMockSource(
        db,
        z.string().parse(values.source),
        actor,
      );
      break;
    case 'source-suspend':
      result = await suspendSource(db, z.string().parse(values.source), actor);
      break;
    case 'collect-mock': {
      const id = z.string().parse(values.source);
      const source = (
        await db.pool.query<{ type: RegistrySource['type'] }>(
          'SELECT type FROM sources WHERE source_id=$1',
          [id],
        )
      ).rows[0];
      if (!source) throw new Error('Source not found');
      result = await collectSource(db, id, values.key ?? randomUUID(), {
        actor,
        transport: mockTransportFor(source.type),
        force: values.force === true,
      });
      break;
    }
    case 'purge':
      result = await purgeExpiredMetadata(db, actor);
      break;
    case 'correct-match':
      if (!values.file) throw new Error('--file correction.json required');
      result = await correctProductMatch(
        db,
        z.uuid().parse(values.id),
        JSON.parse(await readFile(values.file, 'utf8')),
        actor,
      );
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
