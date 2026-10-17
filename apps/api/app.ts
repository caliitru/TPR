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
import { exportLocal, retractions } from '../../packages/adapters/export.js';
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
  server.get(
    '/sources',
    async () =>
      (
        await db.pool.query(
          'SELECT s.*,p.status,p.permission_reference,p.expires_at FROM sources s JOIN source_policies p USING(policy_id) ORDER BY source_id',
        )
      ).rows,
  );
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
  server.post('/exports/preview', async () => ({
    states: (
      await db.pool.query(
        'SELECT review_status,count(*)::int FROM observations GROUP BY review_status',
      )
    ).rows,
    note: 'Final export rechecks current rights and quality; preview authorizes no publication.',
  }));
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
    return suppress(db, { source_id: id }, 'source_disabled', a);
  });
  server.post('/takedowns', async (req) => {
    const a = admin(req);
    const b = z
      .strictObject({ item_id: z.uuid(), reason: z.string().min(1).max(200) })
      .parse(req.body);
    return suppress(db, { item_id: b.item_id }, b.reason, a);
  });
  return server;
}
