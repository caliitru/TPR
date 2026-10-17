import { database } from '../packages/db/client.js';
const db = database();
try {
  if (
    !(
      await db.pool.query(
        "SELECT 1 FROM pg_database WHERE datname='tpr_ingestion_test'",
      )
    ).rowCount
  )
    await db.pool.query('CREATE DATABASE tpr_ingestion_test');
  console.log('Isolated tpr_ingestion_test database exists');
} finally {
  await db.pool.end();
}
