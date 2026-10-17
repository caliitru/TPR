import { database } from '../packages/db/client.js';
import { migrate } from '../packages/db/migrate.js';
const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down')
  throw new Error('Use up or down');
if (direction === 'down' && process.env.ALLOW_LOCAL_RESET !== 'yes')
  throw new Error('Rollback deletes local data; set ALLOW_LOCAL_RESET=yes');
const db = database();
try {
  await migrate(db, direction);
  console.log(`Migration ${direction}: complete`);
} finally {
  await db.pool.end();
}
