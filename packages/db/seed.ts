import { readFile } from 'node:fs/promises';
import { transaction, type Database } from './client.js';
import { fixtureSources } from '../connectors/index.js';
import { normalize, stableId } from '../core/identity.js';
import { productId } from '../core/catalog.js';
import { z } from 'zod';
const product = z.strictObject({
  slug: z.string(),
  brand: z.string(),
  name: z.string(),
  model_number: z.string(),
  type: z.literal('driver'),
  aliases: z.array(z.string()),
});
export async function seed(db: Database) {
  const products = z
    .array(product)
    .parse(
      JSON.parse(
        await readFile(
          new URL('../../fixtures/products.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  await transaction(db, async (c) => {
    await c.query(
      `INSERT INTO source_policies(policy_id,status,allowed_operations,permission_reference,reviewed_by,reviewed_at,expires_at,retention) VALUES ('fixture-only-v1','approved',$1,'repository synthetic fixtures only','fixture-owner','2026-01-01','2099-01-01',$2) ON CONFLICT DO NOTHING`,
      [
        {
          derived_insights: true,
          export_analysis: true,
          export_ratings: true,
          live_network: false,
        },
        { raw_text_hours: 0, metadata_days: 90 },
      ],
    );
    for (const source of fixtureSources)
      await c.query(
        `INSERT INTO sources(source_id,name,type,enabled,policy_id) VALUES($1,$1,$1,true,'fixture-only-v1') ON CONFLICT DO NOTHING`,
        [source],
      );
    for (const p of products) {
      const id = productId(p.slug);
      await c.query(
        `INSERT INTO catalog_products(product_id,slug,brand,name,model_number,category,type,catalog_snapshot_version) VALUES($1,$2,$3,$4,$5,'Clubs',$6,'synthetic-v1') ON CONFLICT DO NOTHING`,
        [id, p.slug, p.brand, p.name, p.model_number, p.type],
      );
      for (const alias of p.aliases)
        await c.query(
          `INSERT INTO product_aliases VALUES($1,$2,$3,'curated-fixture') ON CONFLICT DO NOTHING`,
          [stableId(`alias:${id}:${normalize(alias)}`), id, normalize(alias)],
        );
    }
  });
  return { products: products.length, sources: fixtureSources.length };
}
