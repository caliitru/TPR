import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../core/config.js';
export function database(env: NodeJS.ProcessEnv = process.env) {
  const pool = new pg.Pool({
    connectionString: config(env).databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  return { pool, orm: drizzle(pool) };
}
export type Database = ReturnType<typeof database>;
export async function transaction<T>(
  db: Database,
  fn: (c: pg.PoolClient) => Promise<T>,
) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
