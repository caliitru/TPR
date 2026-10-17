import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { type Database } from './client.js';
import { hash } from '../core/identity.js';
const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
export async function migrate(db: Database, direction: 'up' | 'down' = 'up') {
  const up = await readFile(`${dir}0001_init.up.sql`, 'utf8');
  // Drizzle transaction binds the advisory lock and migration statements to one connection.
  await db.orm.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(717440)`);
    await tx.execute(
      sql`CREATE TABLE IF NOT EXISTS tpr_migrations (id text PRIMARY KEY, checksum text NOT NULL)`,
    );
    const applied = await tx.execute<{ checksum: string }>(
      sql`SELECT checksum FROM tpr_migrations WHERE id='0001_init'`,
    );
    if (applied.rows[0] && applied.rows[0].checksum !== hash(up))
      throw new Error('Migration checksum mismatch');
    if (direction === 'up' && !applied.rows.length) {
      await tx.execute(sql.raw(up));
      await tx.execute(
        sql`INSERT INTO tpr_migrations VALUES ('0001_init',${hash(up)})`,
      );
    } else if (direction === 'down' && applied.rows.length) {
      await tx.execute(
        sql.raw(await readFile(`${dir}0001_init.down.sql`, 'utf8')),
      );
      await tx.execute(sql`DELETE FROM tpr_migrations WHERE id='0001_init'`);
    }
  });
}
