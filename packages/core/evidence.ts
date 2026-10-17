import { z } from 'zod';
import { observation, type Observation } from '../contracts/index.js';
import {
  type ExternalRecord,
  type RegistrySource,
} from '../contracts/sources.js';
import { hash, stableId } from './identity.js';
import { resolveMention, type IntelligentProduct } from './intelligence.js';
const span = z.strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
const topic = z.enum([
  'forgiveness',
  'dispersion',
  'sound',
  'feel',
  'distance',
  'spin',
  'launch',
  'durability',
  'ease_of_use',
  'value',
]);
export const extractionProposal = z.strictObject({
  attributes: z
    .array(
      z.strictObject({
        topic,
        polarity: z.enum(['positive', 'negative']),
        support: span,
      }),
    )
    .max(30),
  experience: z.enum(['firsthand', 'secondhand', 'unknown']),
  experience_support: span.nullable(),
  confidence: z.number().min(0).max(1),
});
export interface ExtractionProvider {
  readonly version: string;
  extract(input: Readonly<{ body: string }>): Promise<unknown>;
}
// No hosted model/provider or source instructions are executed. Models may only propose bounded supported spans.
export class RuleEvidenceProvider implements ExtractionProvider {
  readonly version = 'rules-v2';
  async extract(input: { body: string }) {
    const attributes: z.infer<typeof extractionProposal>['attributes'] = [];
    const patterns: [z.infer<typeof topic>, RegExp][] = [
      ['forgiveness', /\b(good|excellent|poor|bad) forgiveness\b/gi],
      ['dispersion', /\b(tight|wide|poor) dispersion\b/gi],
      ['sound', /\b(good|harsh|bad) sound\b/gi],
      ['distance', /\b(good|poor) distance\b/gi],
      ['feel', /\b(good|bad) feel\b/gi],
    ];
    for (const [topic, re] of patterns)
      for (const m of input.body.matchAll(re)) {
        const before = input.body.slice(Math.max(0, m.index - 16), m.index);
        if (/\b(not|never|isn't|wasn't|no)\b/i.test(before)) continue;
        attributes.push({
          topic,
          polarity: /poor|bad|wide|harsh/i.test(m[0]) ? 'negative' : 'positive',
          support: { start: m.index, end: m.index + m[0].length },
        });
      }
    const exp = /\bI (played|used|tested|own)\b/i.exec(input.body);
    const indirect = /\b(my friend|someone|they) (said|played|used)\b/i.test(
      input.body,
    );
    const negated =
      exp &&
      /\b(not|never|didn't|haven't)\b/i.test(
        input.body.slice(Math.max(0, exp.index - 20), exp.index),
      );
    return {
      attributes,
      experience:
        exp && !negated && !indirect
          ? 'firsthand'
          : indirect
            ? 'secondhand'
            : 'unknown',
      experience_support:
        exp && !negated && !indirect
          ? { start: exp.index, end: exp.index + exp[0].length }
          : null,
      confidence: attributes.length ? 0.7 : 0,
    };
  }
}
export async function extractExternal(
  record: ExternalRecord,
  source: RegistrySource,
  products: IntelligentProduct[],
  provider: ExtractionProvider = new RuleEvidenceProvider(),
) {
  const body =
    source.allowed_operations.analyze_body &&
    source.allowed_operations.derived_insights
      ? record.body
      : '';
  const raw = body
    ? extractionProposal.parse(await provider.extract({ body }))
    : extractionProposal.parse({
        attributes: [],
        experience: 'unknown',
        experience_support: null,
        confidence: 0,
      });
  const valid = (s: z.infer<typeof span>) =>
    s.start < s.end && s.end <= body.length;
  if (
    raw.attributes.some((a) => !valid(a.support)) ||
    (raw.experience_support && !valid(raw.experience_support))
  )
    throw new Error('Unsupported extraction spans');
  const first =
    raw.experience === 'firsthand' &&
    raw.experience_support &&
    /\bI (played|used|tested|own)\b/i.test(
      body.slice(raw.experience_support.start, raw.experience_support.end),
    ) &&
    record.kind === 'player' &&
    !record.structured.sponsored;
  const positives = raw.attributes.filter(
      (a) => a.polarity === 'positive',
    ).length,
    negatives = raw.attributes.filter((a) => a.polarity === 'negative').length;
  const sentiment: Observation['sentiment'] =
    positives && negatives
      ? 'mixed'
      : positives
        ? 'positive'
        : negatives
          ? 'negative'
          : 'unknown';
  const product = resolveMention(
    { label: record.product_label || record.title },
    products,
  );
  const identity = hash(`external:${source.source_id}:${record.external_id}`);
  const fingerprint = hash(`${identity}:${source.policy_id}`);
  const kind: Observation['observation_kind'] = record.structured.sponsored
    ? 'marketing'
    : first
      ? 'first_hand_player_experience'
      : record.kind === 'editorial'
        ? 'editorial'
        : record.kind === 'discovery'
          ? 'unknown'
          : 'discussion';
  const flags: string[] = [];
  if (!product.catalog_product_id) flags.push('ambiguous_product');
  if (record.kind === 'discovery' || !body) flags.push('metadata_only');
  if (record.structured.sponsored) flags.push('sponsored');
  if (record.kind === 'player' && !first) flags.push('not_first_hand');
  const obs = observation.parse({
    schema_version: '1.0',
    observation_id: stableId(`external-observation:${fingerprint}`),
    source_id: source.source_id,
    source_item_id: record.external_id,
    source_url: record.url,
    published_at: record.published_at,
    collected_at: new Date().toISOString(),
    observation_kind: kind,
    review_status: 'staged',
    evidence_basis: body ? 'inferred' : 'unknown',
    product_match: product,
    sentiment: record.kind === 'discovery' ? 'unknown' : sentiment,
    topic: raw.attributes[0]?.topic ?? null,
    explicit_rating: first ? (record.structured.explicit_rating ?? null) : null,
    player_type: first ? (record.structured.player_type ?? null) : null,
    player_type_basis:
      first && record.structured.player_type ? 'explicit' : 'unknown',
    first_hand_confidence: first ? Math.min(raw.confidence, 0.8) : 0,
    model_version: provider.version,
    prompt_version: null,
    source_content_hash: hash(JSON.stringify(record)),
    independence_group_key: identity,
    rights_policy_id: source.policy_id,
    quality_flags: flags,
    reviewer_id: null,
    reviewed_at: null,
  });
  // Preserve only derived topic/polarity and a support hash; no source quotations or article bodies.
  const evidence = {
    attributes: raw.attributes.map((a) => ({
      topic: a.topic,
      polarity: a.polarity,
      support_hash: hash(body.slice(a.support.start, a.support.end)),
    })),
    extraction_confidence: raw.confidence,
    experience_basis: first
      ? 'explicit_first_person'
      : raw.experience === 'secondhand'
        ? 'secondhand'
        : 'unknown',
    provenance: {
      source_url: record.url,
      published_at: record.published_at,
      provider: provider.version,
    },
  };
  return { obs, evidence, fingerprint };
}
