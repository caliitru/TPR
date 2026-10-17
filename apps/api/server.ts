import { database } from '../../packages/db/client.js';
import { app } from './app.js';
const db = database();
const server = app(db, {
  reviewer: process.env.TPR_REVIEWER_TOKEN ?? '',
  admin: process.env.TPR_ADMIN_TOKEN ?? '',
});
try {
  await server.listen({ host: '127.0.0.1', port: 4310 });
  console.log('TPR private review API listening on loopback port 4310');
} catch {
  await db.pool.end();
  throw new Error('API startup failed');
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void server.close().then(() => db.pool.end());
  });
