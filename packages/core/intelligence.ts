import { z } from 'zod';
import { normalize, stableId } from './identity.js';
import { matchProduct, type Product } from './catalog.js';
export const productTypes = z.enum([
  'driver',
  'fairway-wood',
  'hybrid',
  'iron',
  'wedge',
  'putter',
  'golf-ball',
  'stand-bag',
  'cart-bag',
  'travel-bag',
  'launch-monitor',
  'rangefinder',
  'golf-watch',
]);
export const catalogRecord = z.strictObject({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  brand: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  model_number: z.string().min(1).max(80),
  type: productTypes,
  category: z.enum(['Clubs', 'Tech', 'Bags & Balls']),
  generation: z.string().max(80).nullable().default(null),
  family: z.string().max(80).nullable().default(null),
  variant: z.string().max(80).nullable().default(null),
  configurations: z
    .record(z.string().max(40), z.array(z.string().max(80)))
    .default({}),
  brand_aliases: z.array(z.string().max(80)).default([]),
  aliases: z.array(z.string().min(1).max(200)).max(100),
});
export interface IntelligentProduct extends Product {
  type?: string;
  generation?: string | null;
  family?: string | null;
  variant?: string | null;
  configurations?: Record<string, string[]>;
  brand_aliases?: string[];
}
export const mention = z.strictObject({
  label: z.string().min(1).max(2000),
  brand: z.string().max(80).optional(),
  generation: z.string().max(80).optional(),
  type: productTypes.optional(),
  variant: z.string().max(80).optional(),
  configuration: z.record(z.string(), z.string()).optional(),
});
export function resolveMention(
  input: z.infer<typeof mention>,
  products: IntelligentProduct[],
) {
  const m = mention.parse(input);
  const n = normalize(m.label);
  const years = [...n.matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => m[0]);
  const candidates = products.filter(
    (p) =>
      (!years.length || (years.length === 1 && p.generation === years[0])) &&
      (!m.brand ||
        [p.brand, ...(p.brand_aliases ?? [])].some(
          (b) => normalize(b) === normalize(m.brand!),
        )) &&
      (!m.generation || p.generation === m.generation) &&
      (!m.type || p.type === m.type) &&
      (!m.variant || normalize(p.variant ?? '') === normalize(m.variant)) &&
      (!m.configuration ||
        Object.entries(m.configuration).every(([k, v]) =>
          p.configurations?.[k]?.includes(v),
        )),
  );
  // Expand only curated brand aliases. Unknown generations/variants are never fuzzy matched.
  const labels = new Set([n]);
  for (const p of candidates)
    for (const alias of p.brand_aliases ?? [])
      if (n.startsWith(normalize(alias) + ' '))
        labels.add(
          normalize(p.brand) + ' ' + n.slice(normalize(alias).length + 1),
        );
  const matched = candidates.filter((p) =>
    [p.name, ...p.aliases, p.model_number].some((a) =>
      [...labels].some((label) =>
        (' ' + label + ' ').includes(' ' + normalize(a) + ' '),
      ),
    ),
  );
  // References to multiple variants of one family must abstain, even when one full name matched.
  const families = new Set(matched.map((p) => p.family).filter(Boolean));
  const variantConflict = [...families].some(
    (f) =>
      products.filter(
        (p) =>
          p.family === f &&
          p.variant &&
          (' ' + n + ' ').includes(' ' + normalize(p.variant) + ' '),
      ).length > 1,
  );
  if (matched.length !== 1 || variantConflict)
    return {
      catalog_product_id: null,
      candidate_label: m.label,
      confidence: 0,
      method: 'unmatched' as const,
    };
  const p = matched[0]!;
  const exact = matchProduct(m.label, candidates);
  return exact.catalog_product_id
    ? exact
    : {
        catalog_product_id: p.product_id,
        candidate_label: m.label,
        confidence: 0.95,
        method: 'contextual' as const,
      };
}
export const intelligentProductId = (slug: string) =>
  stableId(`product:${slug}`);
