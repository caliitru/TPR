import {
  observation,
  type SourceItem,
  type Observation,
} from '../contracts/index.js';
import { canonicalUrl, hash, normalize, stableId } from './identity.js';
import { matchProduct, type Product } from './catalog.js';
// Source bodies are transient. Fixture fields are structured synthetic evidence, never model instructions.
export function extract(
  item: SourceItem,
  source: string,
  policy: string,
  products: Product[],
  now = new Date(),
): Observation {
  const match = matchProduct(item.product_label, products);
  const firsthand =
    item.kind === 'player' &&
    item.first_hand &&
    /\bI (played|used|tested|own)\b/i.test(item.text);
  const kind: Observation['observation_kind'] = item.sponsored
    ? 'marketing'
    : firsthand
      ? 'first_hand_player_experience'
      : item.kind === 'editorial'
        ? 'editorial'
        : item.kind === 'manufacturer'
          ? 'manufacturer_fact'
          : 'discussion';
  const flags: string[] = [];
  if (!match.catalog_product_id) flags.push('ambiguous_product');
  if (!firsthand) flags.push('not_first_hand');
  if (item.sponsored) flags.push('sponsored');
  const group = hash(`fixture-experience:${item.experience_id}`);
  const fingerprint = hash(
    `${group}:${match.catalog_product_id ?? normalize(item.product_label)}:${item.topic ?? 'unknown'}`,
  );
  return observation.parse({
    schema_version: '1.0',
    observation_id: stableId(`observation:${fingerprint}`),
    source_id: source,
    source_item_id: item.external_id,
    source_url: canonicalUrl(item.url),
    published_at: new Date(item.published_at).toISOString(),
    collected_at: now.toISOString(),
    observation_kind: kind,
    review_status: 'staged',
    evidence_basis: 'structured_source_field',
    product_match: match,
    sentiment: kind === 'manufacturer_fact' ? 'unknown' : item.sentiment,
    topic: item.topic,
    explicit_rating:
      kind === 'first_hand_player_experience' ? item.explicit_rating : null,
    player_type:
      kind === 'first_hand_player_experience' ? item.player_type : null,
    player_type_basis:
      kind === 'first_hand_player_experience' && item.player_type
        ? 'explicit'
        : 'unknown',
    first_hand_confidence: firsthand && !item.sponsored ? 1 : 0,
    model_version: 'fixture-rule-v1',
    prompt_version: null,
    source_content_hash: hash(normalize(item.text)),
    independence_group_key: group,
    rights_policy_id: policy,
    quality_flags: flags,
    reviewer_id: null,
    reviewed_at: null,
  });
}
export interface EvidenceAdapter {
  extract(
    item: SourceItem,
    source: string,
    policy: string,
    products: Product[],
  ): Promise<Observation>;
}
export class MockEvidenceAdapter implements EvidenceAdapter {
  async extract(
    item: SourceItem,
    source: string,
    policy: string,
    products: Product[],
  ) {
    return extract(item, source, policy, products);
  }
}
