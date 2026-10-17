import type pg from 'pg';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction, type Database } from '../db/client.js';
import {
  observation,
  exportManifest,
  type Observation,
} from '../contracts/index.js';
import { requireActor, type Actor } from '../core/moderation.js';
import { policy } from '../core/pipeline.js';
import { assertPolicy } from '../core/policy.js';
import { hash } from '../core/identity.js';
export const ratingCandidate = z.strictObject({
  slug: z.string().min(1),
  player_type: z.enum([
    'Beginner',
    'High Handicap',
    'Mid Handicap',
    'Low Handicap',
    'Scratch+',
  ]),
  rating: z.number().int().min(1).max(5),
  would_recommend: z.boolean(),
  worth_the_price: z.boolean(),
  source: z.string().min(1),
  source_url: z.url().startsWith('https://'),
  observed_at: z.iso.datetime({ offset: true }),
});
export type ExportType = 'analysis_observations' | 'explicit_rating_candidates';
interface Row {
  payload: Observation;
  slug: string;
  export_fields: {
    would_recommend: boolean | null;
    worth_the_price: boolean | null;
  };
}
export async function exportLocal(
  db: Database,
  options: {
    actor: Actor;
    authorizeLocalExport: boolean;
    type: ExportType;
    directory?: string;
  },
) {
  requireActor(options.actor, true);
  if (options.authorizeLocalExport !== true)
    throw new Error('Explicit local batch authorization required');
  if (
    !['analysis_observations', 'explicit_rating_candidates'].includes(
      options.type,
    )
  )
    throw new Error('Unknown export type');
  const base = resolve(options.directory ?? 'artifacts');
  const id = randomUUID();
  await mkdir(base, { recursive: true, mode: 0o700 });
  const temp = join(base, `.${id}.tmp`),
    dest = join(base, id);
  await mkdir(temp, { mode: 0o700 });
  try {
    const manifest = await transaction(db, async (c) => {
      const { output, included } = await eligibleExport(c, options.type);
      const jsonl =
        output.map((o) => JSON.stringify(o)).join('\n') +
        (output.length ? '\n' : '');
      const totals = (
        await c.query<{ review_status: string; count: number }>(
          'SELECT review_status,count(*)::int AS count FROM observations GROUP BY review_status',
        )
      ).rows;
      const unresolved = (
        await c.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM observations WHERE product_id IS NULL',
        )
      ).rows[0]!.count;
      const result = exportManifest.parse({
        schema_version: '1.0',
        batch_id: id,
        produced_at: new Date().toISOString(),
        environment: 'fixture-local',
        export_type: options.type,
        count: output.length,
        file_sha256: hash(jsonl),
        source_policy_ids: [
          ...new Set(included.map((o) => o.rights_policy_id)),
        ],
        evidence_types: [...new Set(included.map((o) => o.evidence_basis))],
        review_totals: Object.fromEntries(
          totals.map((t) => [t.review_status, t.count]),
        ),
        unresolved_items: unresolved,
        synthetic: true,
        authorization_actor: options.actor.id,
      });
      await writeFile(join(temp, 'observations.jsonl'), jsonl, { mode: 0o600 });
      await writeFile(
        join(temp, 'manifest.json'),
        JSON.stringify(result, null, 2) + '\n',
        { mode: 0o600 },
      );
      await writeFile(
        join(temp, 'sha256.txt'),
        `${result.file_sha256}  observations.jsonl\n`,
        { mode: 0o600 },
      );
      if (options.type === 'explicit_rating_candidates') {
        const columns = [
          'slug',
          'player_type',
          'rating',
          'would_recommend',
          'worth_the_price',
          'source',
          'source_url',
          'observed_at',
        ] as const;
        const csv =
          [
            columns.join(','),
            ...output.map((value) => {
              const r = ratingCandidate.parse(value);
              return columns
                .map((k) => '"' + String(r[k]).replaceAll('"', '""') + '"')
                .join(',');
            }),
          ].join('\n') + '\n';
        await writeFile(join(temp, 'rating-candidates.csv'), csv, {
          mode: 0o600,
        });
        await writeFile(
          join(temp, 'rating-candidates.sha256'),
          hash(csv) + '  rating-candidates.csv\n',
          { mode: 0o600 },
        );
      }
      await c.query(
        `INSERT INTO export_batches(batch_id,schema_version,count,file_sha256,manifest,observation_ids) VALUES($1,'1.0',$2,$3,$4,$5)`,
        [
          id,
          result.count,
          result.file_sha256,
          result,
          included.map((o) => o.observation_id),
        ],
      );
      await rename(temp, dest);
      return result;
    });
    return { directory: dest, manifest };
  } catch (e) {
    await rm(temp, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
    throw e;
  }
}
export async function retractions(db: Database) {
  return (
    await db.pool.query(
      `SELECT batch_id,file_sha256,produced_at FROM export_batches WHERE retraction_required=true ORDER BY produced_at`,
    )
  ).rows;
}

async function eligibleExport(c: pg.PoolClient, type: ExportType) {
  const rows = (
    await c.query<Row>(
      `SELECT o.payload,o.export_fields,p.slug FROM observations o JOIN source_items i USING(item_id) JOIN catalog_products p ON p.product_id=o.product_id WHERE o.review_status='approved_for_analysis' AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.item_id=o.item_id OR t.source_id=i.source_id) ORDER BY o.observation_id FOR SHARE OF o`,
    )
  ).rows;
  const output: unknown[] = [];
  const included: Observation[] = [];
  for (const row of rows) {
    const obs = observation.parse(row.payload);
    try {
      const currentPolicy = await policy(c, obs.source_id);
      if (currentPolicy.policy_id !== obs.rights_policy_id) continue;
      assertPolicy(
        currentPolicy,
        type === 'analysis_observations' ? 'export_analysis' : 'export_ratings',
      );
    } catch {
      continue;
    }
    if (
      obs.review_status !== 'approved_for_analysis' ||
      obs.quality_flags.length ||
      !['first_hand_player_experience', 'editorial'].includes(
        obs.observation_kind,
      )
    )
      continue;
    if (type === 'analysis_observations') output.push(obs);
    else {
      const r = obs.explicit_rating;
      // No remapping, no rounding, no inferred context/booleans. Only an explicit, understood native 1–5 scale.
      if (
        !r ||
        obs.observation_kind !== 'first_hand_player_experience' ||
        !obs.published_at ||
        r.scale_min !== 1 ||
        r.scale_max !== 5 ||
        !Number.isInteger(r.value) ||
        !obs.player_type ||
        obs.player_type_basis !== 'explicit' ||
        row.export_fields.would_recommend === null ||
        row.export_fields.worth_the_price === null
      )
        continue;
      output.push(
        ratingCandidate.parse({
          slug: row.slug,
          player_type: obs.player_type,
          rating: r.value,
          would_recommend: row.export_fields.would_recommend,
          worth_the_price: row.export_fields.worth_the_price,
          source: obs.source_id,
          source_url: obs.source_url,
          observed_at: obs.published_at,
        }),
      );
    }
    included.push(obs);
  }

  return { output, included };
}
export async function previewExport(
  db: Database,
  actor: Actor,
  type: ExportType = 'analysis_observations',
) {
  requireActor(actor);
  if (!['analysis_observations', 'explicit_rating_candidates'].includes(type))
    throw new Error('Unknown export type');
  return transaction(db, async (c) => {
    const { output } = await eligibleExport(c, type);
    return {
      type,
      eligible: output.length,
      publication: false,
      local_only: true,
    };
  });
}
