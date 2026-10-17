import { normalize, stableId } from './identity.js';
import type { Observation } from '../contracts/index.js';
export interface Product {
  product_id: string;
  slug: string;
  brand: string;
  name: string;
  model_number: string;
  aliases: string[];
}
export function matchProduct(
  label: string,
  products: Product[],
): Observation['product_match'] {
  const n = normalize(label);
  const exact = products.filter((p) => normalize(p.name) === n);
  const model = products.filter(
    (p) => p.model_number.toLowerCase() === label.trim().toLowerCase(),
  );
  const aliases = products.filter((p) =>
    p.aliases.some((a) => normalize(a) === n),
  );
  const candidates = exact.length ? exact : model.length ? model : aliases;
  if (candidates.length !== 1)
    return {
      catalog_product_id: null,
      candidate_label: label,
      confidence: 0,
      method: 'unmatched',
    };
  return {
    catalog_product_id: candidates[0]!.product_id,
    candidate_label: label,
    confidence: 1,
    method: exact.length ? 'exact' : model.length ? 'model_number' : 'alias',
  };
}
export const productId = (slug: string) => stableId(`product:${slug}`);
