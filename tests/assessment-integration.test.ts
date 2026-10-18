import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { database } from '../packages/db/client.js';
import { migrate } from '../packages/db/migrate.js';
import { seed } from '../packages/db/seed.js';
import { seedSourceCatalog } from '../packages/db/source-catalog.js';
import { assessSources } from '../packages/core/source-assessment.js';
import { parsePolicyEvidence } from '../packages/core/policy-research.js';
if (!process.env.DATABASE_URL?.endsWith('/tpr_ingestion_test'))
  throw new Error('Assessment tests require isolated test DB');
const db = database(),
  actor = { id: 'assessment-test-admin', role: 'admin' as const };
beforeAll(async () => {
  await migrate(db);
});
afterAll(async () => {
  await db.pool.end();
});
beforeEach(async () => {
  await db.pool.query(
    'TRUNCATE source_assessment_runs,weekly_reports,job_events,tombstones,export_batches,review_events,observations,source_items,crawl_jobs,product_aliases,catalog_products,sources,source_policies CASCADE',
  );
  await seed(db);
  await seedSourceCatalog(db, actor);
});
const run = () =>
  assessSources(db, {
    actor,
    fetchPolicy: async (url, hosts) =>
      parsePolicyEvidence(url, hosts, '\nTPR_POLICY_META:000:403', 56),
    youtubeCredentialPresent: false,
    redditCredentialsPresent: false,
  });
it('records all 43 actual registry sources, deduplicates research URLs, and keeps real acquisition at zero', async () => {
  await db.pool.query(
    "UPDATE sources SET name='PING reviewed registry name' WHERE source_id='catalog-manufacturer-ping'",
  );
  const report = await run();
  expect(report.source_count).toBe(43);
  expect(
    report.sources.find((s) => s.source_id === 'catalog-manufacturer-ping')!
      .name,
  ).toBe('PING reviewed registry name');
  expect(report.policy_navigation).toEqual({
    unique_requests_attempted: 36,
    origin_documents_retrieved: 0,
    proxy_denied: 36,
  });
  expect(
    report.sources.every(
      (s) => !s.eligible_for_pilot && s.terms_verified_at === null,
    ),
  ).toBe(true);
  expect(report.real_external_collection.records_retrieved).toBe(0);
  expect(report.real_external_collection.valid_firsthand_observations).toBe(0);
  expect(report.products.available).toBe(6);
  expect(report.mock_testing.included_in_real_totals).toBe(false);
  expect(
    (await db.pool.query('SELECT count(*)::int AS n FROM observations')).rows[0]
      .n,
  ).toBe(0);
});
it('preserves permissions, disabled states, audit snapshots and immutable assessment history', async () => {
  const report = await run();
  expect(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM sources s JOIN source_policies p USING(policy_id) WHERE s.source_id LIKE 'catalog-%' AND (s.enabled OR p.status<>'pending')",
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM source_events WHERE code='source_access_assessed'",
      )
    ).rows[0].n,
  ).toBe(43);
  expect(
    (
      await db.pool.query(
        'SELECT report FROM source_assessment_runs WHERE assessment_id=$1',
        [report.assessment_id],
      )
    ).rows[0].report.real_external_collection.records_retrieved,
  ).toBe(0);
  await expect(
    db.pool.query("UPDATE source_assessment_runs SET actor_id='tampered'"),
  ).rejects.toThrow('append-only');
});
it('requires admin authority and the complete catalog before network research', async () => {
  let calls = 0;
  const options = {
    actor: { id: 'reader-user', role: 'reviewer' as const },
    fetchPolicy: async (url: string, hosts: string[]) => {
      calls++;
      return parsePolicyEvidence(url, hosts, '\nTPR_POLICY_META:000:403', 56);
    },
    youtubeCredentialPresent: false,
    redditCredentialsPresent: false,
  };
  await expect(assessSources(db, options)).rejects.toThrow('Authorized actor');
  expect(calls).toBe(0);
  await db.pool.query('TRUNCATE sources CASCADE');
  await expect(assessSources(db, { ...options, actor })).rejects.toThrow(
    'Seed all 43',
  );
  expect(calls).toBe(0);
});
