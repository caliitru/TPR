import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Database } from '../../packages/db/client.js';
import { decision } from '../../packages/contracts/index.js';
import {
  review,
  suppress,
  type Actor,
} from '../../packages/core/moderation.js';
import { ingest } from '../../packages/core/pipeline.js';
import {
  exportLocal,
  retractions,
  previewExport,
} from '../../packages/adapters/export.js';
import {
  sourceHealth,
  registerSource,
  approveSourcePolicy,
  enableMockSource,
  suspendSource,
} from '../../packages/core/sources.js';
import { collectSource, collectDue } from '../../packages/core/collection.js';
import { mockTransportFor } from '../../packages/connectors/mock-scenarios.js';
import { PinnedHttpsTransport } from '../../packages/connectors/http.js';
import {
  correctProductMatch,
  reviewFact,
  purgeExpiredMetadata,
  addCatalogProduct,
} from '../../packages/core/operations.js';
import type { RegistrySource } from '../../packages/contracts/sources.js';
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function app(
  db: Database,
  tokens: { reviewer: string; admin: string },
  exportDirectory = 'artifacts',
) {
  if (
    tokens.reviewer.length < 24 ||
    tokens.admin.length < 24 ||
    tokens.admin === tokens.reviewer
  )
    throw new Error(
      'Two distinct random tokens of at least 24 characters are required',
    );
  const server = Fastify({
    logger: false,
    bodyLimit: 16384,
    requestTimeout: 10000,
  });
  const actors = new WeakMap<object, Actor>();
  server.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
      .header('Referrer-Policy', 'no-referrer');
    if (req.url === '/health' && req.method === 'GET') return;
    let token = '';
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) token = auth.slice(7);
    else if (auth.startsWith('Basic ')) {
      const text = Buffer.from(auth.slice(6), 'base64').toString();
      token = text.slice(text.indexOf(':') + 1);
    }
    const actor: Actor | undefined = equal(token, tokens.admin)
      ? { id: 'api-admin', role: 'admin' }
      : equal(token, tokens.reviewer)
        ? { id: 'api-reviewer', role: 'reviewer' }
        : undefined;
    if (!actor)
      return reply
        .header('WWW-Authenticate', 'Basic realm="TPR local review"')
        .code(401)
        .send({ error: 'Authentication required' });
    actors.set(req, actor);
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers['x-tpr-review'] !== '1')
        return reply
          .code(403)
          .send({ error: 'Review request header required' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`)
        return reply.code(403).send({ error: 'Cross-origin mutation denied' });
    }
  });
  server.setErrorHandler((error, _req, reply) => {
    reply.code(error instanceof z.ZodError ? 400 : 409).send({
      error:
        error instanceof z.ZodError
          ? 'Invalid request'
          : 'Operation rejected; check state, rights, role, and transition',
    });
  });
  const actor = (req: object) => actors.get(req)!;
  const admin = (req: object) => {
    if (actor(req).role !== 'admin') throw new Error('Admin required');
    return actor(req);
  };
  server.get('/health', async () => {
    await db.pool.query('SELECT 1');
    return {
      status: 'ok',
      mode: 'fixture-local',
      network: false,
      production_publication: false,
    };
  });
  server.get('/admin', async (_req, reply) =>
    reply
      .type('text/html')
      .send(
        await readFile(new URL('../admin/index.html', import.meta.url), 'utf8'),
      ),
  );
  server.get('/admin.js', async (_req, reply) =>
    reply
      .type('application/javascript')
      .send(
        await readFile(new URL('../admin/admin.js', import.meta.url), 'utf8'),
      ),
  );
  server.get('/sources', async (req) => sourceHealth(db, req.query));
  server.post('/runs/fixtures', async (req) => {
    admin(req);
    const body = z
      .strictObject({ idempotency_key: z.string().min(8).max(128) })
      .parse(req.body);
    return ingest(db, body.idempotency_key);
  });
  server.get('/jobs/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return (
      (
        await db.pool.query(
          'SELECT job_id,source_id,state,attempts,error_code,external_cursor FROM crawl_jobs WHERE job_id=$1',
          [id],
        )
      ).rows[0] ?? null
    );
  });
  server.get('/observations', async (req) => {
    const q = z
      .object({
        status: z
          .enum(['staged', 'approved_for_analysis', 'rejected', 'revoked'])
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const rows = (
      await db.pool.query(
        `SELECT payload FROM observations WHERE ($1::text IS NULL OR review_status=$1) ORDER BY observation_id LIMIT $2 OFFSET $3`,
        [q.status ?? null, q.limit, q.offset],
      )
    ).rows;
    return {
      items: rows.map((r) => r.payload as unknown),
      limit: q.limit,
      offset: q.offset,
    };
  });
  server.get('/observations/:id/history', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return (
      await db.pool.query(
        'SELECT actor_id,prior_status,new_status,reason,created_at FROM review_events WHERE observation_id=$1 ORDER BY created_at',
        [id],
      )
    ).rows;
  });
  server.post('/observations/:id/decision', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return review(db, id, decision.parse(req.body), actor(req));
  });
  server.post('/exports/preview', async (req) => {
    const b = z
      .strictObject({
        type: z
          .enum(['analysis_observations', 'explicit_rating_candidates'])
          .default('analysis_observations'),
      })
      .parse(req.body ?? {});
    return previewExport(db, actor(req), b.type);
  });
  server.post('/exports/generate', async (req) => {
    const a = admin(req);
    const b = z
      .strictObject({
        authorize_local_export: z.literal(true),
        type: z.enum(['analysis_observations', 'explicit_rating_candidates']),
      })
      .parse(req.body);
    return exportLocal(db, {
      actor: a,
      authorizeLocalExport: b.authorize_local_export,
      type: b.type,
      directory: exportDirectory,
    });
  });
  server.get('/exports/retractions', async () => retractions(db));
  server.post('/sources/:id/disable', async (req) => {
    const a = admin(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return suspendSource(db, id, a);
  });
  server.post('/takedowns', async (req) => {
    const a = admin(req);
    const b = z
      .strictObject({ item_id: z.uuid(), reason: z.string().min(1).max(200) })
      .parse(req.body);
    return suppress(db, { item_id: b.item_id }, b.reason, a);
  });

  server.get('/sources/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return (
      (
        await db.pool.query(
          'SELECT source_id,name,type,url,interval_seconds,daily_budget,min_request_interval_ms,settings,registry FROM sources WHERE source_id=$1',
          [id],
        )
      ).rows[0] ?? null
    );
  });
  server.post('/sources', async (req) =>
    registerSource(db, req.body, admin(req)),
  );
  server.put('/sources/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ source_id: z.literal(id) })
      .passthrough()
      .parse(req.body);
    return registerSource(db, body, admin(req), true);
  });
  server.post('/sources/:id/policy', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return approveSourcePolicy(db, id, req.body, admin(req));
  });
  server.post('/sources/:id/enable-mock', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return enableMockSource(db, id, admin(req));
  });
  server.post('/sources/:id/collect-mock', async (req) => {
    const a = admin(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .strictObject({
        idempotency_key: z.string().min(8).max(128),
        force: z.boolean().default(false),
      })
      .parse(req.body);
    const row = (
      await db.pool.query<{ type: RegistrySource['type'] }>(
        'SELECT type FROM sources WHERE source_id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('Source not found');
    return collectSource(db, id, b.idempotency_key, {
      actor: a,
      transport: mockTransportFor(row.type),
      force: b.force,
    });
  });
  server.post('/collections/due-mock', async (req) =>
    collectDue(db, {
      actor: admin(req),
      transport: new PinnedHttpsTransport([]),
      transportForSource: async (id) => {
        const source = (
          await db.pool.query<{ type: RegistrySource['type'] }>(
            'SELECT type FROM sources WHERE source_id=$1',
            [id],
          )
        ).rows[0]!;
        return mockTransportFor(source.type);
      },
    }),
  );
  server.get('/sources/:id/events', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return (
      await db.pool.query(
        'SELECT actor_id,code,details,created_at FROM source_events WHERE source_id=$1 ORDER BY created_at DESC LIMIT 100',
        [id],
      )
    ).rows;
  });
  server.get('/jobs', async (req) => {
    const q = z
      .object({
        source_id: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    return (
      await db.pool.query(
        'SELECT job_id,source_id,run_key,state,attempts,error_code,next_retry_at,queued_at,external_cursor FROM crawl_jobs WHERE ($1::text IS NULL OR source_id=$1) ORDER BY queued_at DESC LIMIT $2 OFFSET $3',
        [q.source_id ?? null, q.limit, q.offset],
      )
    ).rows;
  });
  server.get('/observations/:id/evidence', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return (
      (
        await db.pool.query(
          'SELECT * FROM observation_evidence WHERE observation_id=$1',
          [id],
        )
      ).rows[0] ?? null
    );
  });
  server.post('/observations/:id/product-match', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return correctProductMatch(db, id, req.body, actor(req));
  });
  server.get(
    '/products',
    async () =>
      (
        await db.pool.query(
          'SELECT product_id,slug,name,brand,type,generation,family,variant,configurations FROM catalog_products ORDER BY name',
        )
      ).rows,
  );
  server.post('/products', async (req) =>
    addCatalogProduct(db, req.body, admin(req)),
  );
  server.get('/facts', async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    return (
      await db.pool.query(
        'SELECT f.*,i.canonical_url AS source_url,i.source_id FROM manufacturer_facts f JOIN source_items i USING(item_id) ORDER BY f.created_at DESC LIMIT $1 OFFSET $2',
        [q.limit, q.offset],
      )
    ).rows;
  });
  server.post('/facts/:id/decision', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z
      .strictObject({ action: z.enum(['approve', 'reject', 'revoke']) })
      .parse(req.body);
    return reviewFact(db, id, b.action, actor(req));
  });
  server.post('/retention/purge', async (req) =>
    purgeExpiredMetadata(db, admin(req)),
  );
  server.get(
    '/exports/history',
    async () =>
      (
        await db.pool.query(
          'SELECT batch_id,manifest,retraction_required FROM export_batches ORDER BY produced_at DESC LIMIT 100',
        )
      ).rows,
  );

  return server;
}
