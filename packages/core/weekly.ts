import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { transaction } from '../db/client.js';
import { collectSource, type CollectionOptions } from './collection.js';
import { assertSource, readSource, sourceEvent } from './sources.js';
import { requireActor } from './moderation.js';
import { stableId } from './identity.js';
import { CollectionError } from '../connectors/http.js';
const WEEK = 7 * 86400000;
const local = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});
/** Latest Sunday 02:00 New York slot. Spring's nonexistent 02:00 runs at 03:00. */
export function weeklySlot(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid schedule time');
  const parts = Object.fromEntries(
    local.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const day = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
  );
  day.setUTCDate(day.getUTCDate() - day.getUTCDay());
  const find = (date: Date) => {
    const target = date.toISOString().slice(0, 10);
    for (let hour = 0; hour < 36; hour++) {
      const candidate = new Date(date.getTime() + hour * 3600000);
      const p = Object.fromEntries(
        local.formatToParts(candidate).map((p) => [p.type, p.value]),
      );
      if (`${p.year}-${p.month}-${p.day}` === target && Number(p.hour) >= 2)
        return candidate;
    }
    throw new Error('Cannot resolve weekly slot');
  };
  let slot = find(day);
  if (slot > now) {
    day.setUTCDate(day.getUTCDate() - 7);
    slot = find(day);
  }
  return slot;
}
export function fiveYearStart(end: Date) {
  const start = new Date(end);
  const month = start.getUTCMonth();
  start.setUTCFullYear(start.getUTCFullYear() - 5);
  if (start.getUTCMonth() !== month) start.setUTCDate(0);
  return start;
}
interface WindowRow {
  window_id: string;
  source_id: string;
  kind: 'weekly' | 'backfill';
  window_start: Date;
  window_end: Date;
  state: string;
  attempts: number;
  job_id: string | null;
  next_retry_at: Date;
  checkpoint: Record<string, unknown>;
  metrics: Record<string, number>;
  last_job_metrics: Record<string, number>;
  error_code: string | null;
}
export interface WeeklyOptions extends CollectionOptions {
  now?: Date;
  end?: Date;
  kind?: 'weekly' | 'backfill';
}
/** Invoke explicitly or from the undeployed timer. No live transport or permission bypass. */
export async function collectWeeklySource(
  db: Database,
  id: string,
  options: WeeklyOptions,
) {
  requireActor(options.actor, true);
  const now = options.now ?? new Date(),
    end = options.end ?? weeklySlot(now),
    kind = options.kind ?? 'weekly';
  if (!Number.isFinite(end.getTime()) || end > now)
    throw new Error('Window end must not be in the future');
  // A dedicated connection avoids exhausting the ingestion pool while holding the session lock.
  const lock = new pg.Client(db.pool.options);
  await lock.connect();
  let acquired = false;
  try {
    acquired = (
      await lock.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,717442)) AS locked',
        [id],
      )
    ).rows[0]!.locked;
    if (!acquired)
      return { source_id: id, state: 'busy', recovery: 'source_locked' };
    const prepared = await transaction(db, async (c) => {
      const source = await readSource(c, id, true);
      assertSource(source, options.transport.mode);
      if (source.lease_until && source.lease_until > new Date())
        throw new CollectionError('source_busy');
      if (source.type !== 'youtube' && !source.settings.window_support)
        throw new CollectionError('window_support_not_verified');
      if (
        kind === 'backfill' &&
        source.type !== 'youtube' &&
        source.settings.window_support !== 'bounded-api'
      )
        throw new CollectionError('backfill_requires_historical_api');
      const existing = (
        await c.query<WindowRow>(
          `SELECT * FROM collection_windows WHERE source_id=$1 AND (state IN ('pending','running','retry') OR (kind=$2 AND ($2='backfill' OR window_end=$3))) ORDER BY created_at LIMIT 1 FOR UPDATE`,
          [id, kind, end],
        )
      ).rows[0];
      if (existing) {
        if (existing.kind !== kind) return { row: existing, skip: true };
        if (existing.state === 'completed')
          return { row: existing, skip: true };
        if (existing.next_retry_at > now) return { row: existing, skip: true };
      }
      let row = existing;
      if (!row) {
        const coverage = (
          await c.query<{
            weekly_covered_until: Date | null;
            earliest: Date | null;
          }>(
            `SELECT weekly_covered_until,(SELECT min(window_start) FROM collection_windows WHERE source_id=$1 AND kind='weekly' AND state='failed' AND (weekly_covered_until IS NULL OR window_end>weekly_covered_until)) AS earliest FROM sources WHERE source_id=$1`,
            [id],
          )
        ).rows[0]!;
        const normal = end.getTime() - WEEK;
        const start =
          kind === 'backfill'
            ? fiveYearStart(end)
            : new Date(
                Math.min(
                  normal,
                  coverage.weekly_covered_until?.getTime() ?? normal,
                  coverage.earliest?.getTime() ?? normal,
                ),
              );
        const windowId = stableId(`window:${id}:${kind}:${end.toISOString()}`);
        row = (
          await c.query<WindowRow>(
            `INSERT INTO collection_windows(window_id,source_id,kind,window_start,window_end) VALUES($1,$2,$3,$4,$5) RETURNING *`,
            [windowId, id, kind, start, end],
          )
        ).rows[0]!;
      }
      if (row.window_end > end) return { row, skip: true };
      await c.query(
        `UPDATE collection_windows SET state='running',attempts=attempts+1,error_code=NULL WHERE window_id=$1`,
        [row.window_id],
      );
      await sourceEvent(c, id, options.actor.id, 'weekly_window_started', {
        window_id: row.window_id,
        kind: row.kind,
        start: row.window_start.toISOString(),
        end: row.window_end.toISOString(),
      });
      return { row, skip: false };
    });
    if (prepared.skip)
      return {
        source_id: id,
        state: prepared.row.state,
        window_id: prepared.row.window_id,
        reused: true,
        metrics: {} as Record<string, number>,
        window_end: prepared.row.window_end,
        recovery: prepared.row.state === 'completed' ? 'covered' : 'waiting',
      };
    const row = prepared.row;
    // Reuse a durable retry job; restart only terminal attempts with a new audited attempt key.
    const previous = row.job_id
      ? (
          await db.pool.query<{ state: string }>(
            'SELECT state FROM crawl_jobs WHERE job_id=$1',
            [row.job_id],
          )
        ).rows[0]
      : undefined;
    const key =
      previous && ['retry', 'running', 'queued'].includes(previous.state)
        ? (
            await db.pool.query<{ run_key: string }>(
              'SELECT run_key FROM crawl_jobs WHERE job_id=$1',
              [row.job_id],
            )
          ).rows[0]!.run_key
        : `weekly-${row.window_id}-${row.attempts + 1}`;
    let result: Awaited<ReturnType<typeof collectSource>>;
    try {
      result = await collectSource(db, id, key, {
        ...options,
        force: true,
        windowId: row.window_id,
        windowCheckpoint: row.checkpoint,
        window: {
          start: row.window_start.toISOString(),
          end: row.window_end.toISOString(),
        },
      });
    } catch (error) {
      await db.pool.query(
        `UPDATE collection_windows SET state='retry',error_code=$2,next_retry_at=now()+interval '60 seconds' WHERE window_id=$1`,
        [
          row.window_id,
          error instanceof CollectionError ? error.code : 'collection_failed',
        ],
      );
      throw error;
    }
    return await transaction(db, async (c) => {
      const job = (
        await c.query<{
          state: string;
          metrics: Record<string, number>;
          next_retry_at: Date;
          error_code: string | null;
        }>(
          'SELECT state,metrics,next_retry_at,error_code FROM crawl_jobs WHERE job_id=$1',
          [result.job_id],
        )
      ).rows[0]!;
      await readSource(c, id, true);
      const checkpoint = (
        await c.query<{ checkpoint: Record<string, unknown> }>(
          'SELECT checkpoint FROM collection_windows WHERE window_id=$1',
          [row.window_id],
        )
      ).rows[0]!.checkpoint;
      const completed = job.state === 'completed';
      const state = completed
        ? 'completed'
        : job.state === 'dead_letter'
          ? 'failed'
          : 'retry';
      // Metrics are cumulative across durable job retries and terminal restarts.
      const metrics = { ...row.metrics };
      const previousMetrics =
        row.job_id === result.job_id ? row.last_job_metrics : {};
      const delta: Record<string, number> = {};
      for (const [k, v] of Object.entries(job.metrics)) {
        delta[k] = v - (previousMetrics[k] ?? 0);
        metrics[k] = (row.metrics[k] ?? 0) + delta[k]!;
      }
      delta.processing_errors = job.error_code ? 1 : 0;
      metrics.processing_errors =
        (row.metrics.processing_errors ?? 0) + (job.error_code ? 1 : 0);
      await c.query<WindowRow>(
        `UPDATE collection_windows SET state=$2,job_id=$3,checkpoint=$4,metrics=$5,last_job_metrics=$8,error_code=$6,next_retry_at=$7,completed_at=CASE WHEN $2='completed' THEN now() ELSE NULL END WHERE window_id=$1 RETURNING *`,
        [
          row.window_id,
          state,
          result.job_id,
          checkpoint,
          metrics,
          job.error_code,
          job.next_retry_at,
          job.metrics,
        ],
      );
      if (completed && row.kind === 'weekly')
        await c.query(
          `UPDATE sources SET weekly_covered_until=GREATEST(weekly_covered_until,$2),weekly_last_success_at=now() WHERE source_id=$1`,
          [id, row.window_end],
        );
      await sourceEvent(c, id, options.actor.id, 'weekly_window_finished', {
        window_id: row.window_id,
        state,
        metrics,
      });
      return {
        source_id: id,
        state,
        window_id: row.window_id,
        window_start: row.window_start,
        window_end: row.window_end,
        metrics: delta,
        error_code: job.error_code,
        recovery: completed
          ? 'covered'
          : state === 'retry'
            ? 'retry_scheduled'
            : 'requires_retry',
      };
    });
  } finally {
    if (acquired)
      await lock.query(
        'SELECT pg_advisory_unlock(hashtextextended($1,717442))',
        [id],
      );
    await lock.end();
  }
}
export async function runWeekly(
  db: Database,
  options: Omit<WeeklyOptions, 'transport'> & {
    transportForSource: (id: string) => Promise<CollectionOptions['transport']>;
    sourceIds?: string[];
  },
) {
  requireActor(options.actor, true);
  const now = options.now ?? new Date(),
    slot = options.end ?? weeklySlot(now);
  const sources =
    options.sourceIds ??
    (
      await db.pool.query<{ source_id: string }>(
        `SELECT s.source_id FROM sources s JOIN source_policies p USING(policy_id) WHERE s.enabled AND s.type NOT LIKE 'fixture-%' AND p.status='approved' AND p.expires_at>now() ORDER BY s.source_id`,
      )
    ).rows.map((r) => r.source_id);
  const missed = (
    await db.pool.query<{ n: number }>(
      `SELECT COALESCE(sum(GREATEST(0,((($1::timestamptz AT TIME ZONE 'America/New_York')::date-(COALESCE(weekly_covered_until,(SELECT min(window_start) FROM collection_windows w WHERE w.source_id=sources.source_id AND w.kind='weekly')) AT TIME ZONE 'America/New_York')::date)/7)-1)),0)::int AS n FROM sources WHERE source_id=ANY($2::text[])`,
      [slot, sources],
    )
  ).rows[0]!.n;
  const results = [];
  for (const id of [...new Set(sources)]) {
    try {
      const transport = await options.transportForSource(id);
      const first = await collectWeeklySource(db, id, {
        ...options,
        now,
        end: slot,
        transport,
      });
      results.push(first);
      if (
        first.state === 'completed' &&
        first.window_end &&
        first.window_end < slot &&
        options.kind !== 'backfill'
      )
        results.push(
          await collectWeeklySource(db, id, {
            ...options,
            now,
            end: slot,
            transport,
          }),
        );
    } catch (error) {
      results.push({
        source_id: id,
        state: 'failed',
        error_code:
          error instanceof CollectionError ? error.code : 'collection_failed',
        recovery: 'permission_or_operator_action_required',
      });
    }
  }
  const totals = (
    await db.pool.query(
      `SELECT count(*)::int AS total_historical_observations, count(*) FILTER(WHERE review_status='staged')::int AS observations_awaiting_moderation FROM observations`,
    )
  ).rows[0]!;
  const metrics: Record<string, number> = {
    new_records: 0,
    valid_player_observations: 0,
    new_observations: 0,
    duplicates_skipped: 0,
    records_updated: 0,
    ambiguous_matches: 0,
    awaiting_moderation: 0,
    processing_errors: 0,
    undated_records: 0,
    outside_window: 0,
  };
  for (const r of results)
    if ('metrics' in r && r.metrics)
      for (const [k, v] of Object.entries(r.metrics))
        metrics[k] = (metrics[k] ?? 0) + Number(v);
  const report = {
    slot: slot.toISOString(),
    timezone: 'America/New_York',
    kind: options.kind ?? 'weekly',
    sources_checked: new Set(results.map((r) => r.source_id)).size,
    missed_runs: missed,
    metrics,
    ...totals,
    failed_sources: results.filter((r) => !['completed'].includes(r.state)),
    sources: results,
    live_requests: 0,
  };
  const reportId = randomUUID();
  await db.pool.query(
    'INSERT INTO weekly_reports(report_id,slot,report) VALUES($1,$2,$3)',
    [reportId, slot, report],
  );
  return { report_id: reportId, ...report };
}

/** Polling is safe: completed sources are skipped until the next Sunday slot. */
export async function weeklyTick(
  db: Database,
  options: Omit<WeeklyOptions, 'transport'> & {
    transportForSource: (id: string) => Promise<CollectionOptions['transport']>;
  },
) {
  const now = options.now ?? new Date(),
    slot = weeklySlot(now);
  const lock = new pg.Client(db.pool.options);
  await lock.connect();
  let acquired = false;
  try {
    acquired = (
      await lock.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(717443) AS locked',
      )
    ).rows[0]!.locked;
    if (!acquired) return { state: 'busy' };
    const ids = (
      await db.pool.query<{ source_id: string }>(
        `SELECT s.source_id FROM sources s JOIN source_policies p USING(policy_id) WHERE s.enabled AND s.type NOT LIKE 'fixture-%' AND p.status='approved' AND p.expires_at>$2 AND (s.weekly_covered_until IS NULL OR s.weekly_covered_until<$1) AND NOT EXISTS(SELECT 1 FROM collection_windows w WHERE w.source_id=s.source_id AND w.kind='backfill' AND w.state IN ('pending','running','retry')) AND NOT EXISTS(SELECT 1 FROM collection_windows w WHERE w.source_id=s.source_id AND w.state IN ('retry','failed') AND w.next_retry_at>$2) ORDER BY s.source_id`,
        [slot, now],
      )
    ).rows.map((r) => r.source_id);
    if (
      !ids.length &&
      (
        await db.pool.query(
          'SELECT 1 FROM weekly_reports WHERE slot=$1 LIMIT 1',
          [slot],
        )
      ).rowCount
    )
      return { state: 'not_due' };
    return await runWeekly(db, {
      ...options,
      now,
      end: slot,
      sourceIds: ids,
      kind: 'weekly',
    });
  } finally {
    if (acquired) await lock.query('SELECT pg_advisory_unlock(717443)');
    await lock.end();
  }
}
