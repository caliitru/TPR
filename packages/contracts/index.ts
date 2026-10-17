import { z } from 'zod';
const timestamp = z.iso.datetime({ offset: true });
export const explicitRating = z
  .strictObject({
    value: z.number(),
    scale_min: z.number(),
    scale_max: z.number(),
    evidence_basis: z.literal('structured_source_field'),
  })
  .refine(
    (r) =>
      r.scale_max > r.scale_min &&
      r.value >= r.scale_min &&
      r.value <= r.scale_max,
    'Invalid rating scale',
  );
export const playerType = z.enum([
  'Beginner',
  'High Handicap',
  'Mid Handicap',
  'Low Handicap',
  'Scratch+',
]);
export const observation = z
  .strictObject({
    schema_version: z.literal('1.0'),
    observation_id: z.uuid(),
    source_id: z.string().min(1),
    source_item_id: z.string().min(1),
    source_url: z.url().startsWith('https://'),
    published_at: timestamp.nullable(),
    collected_at: timestamp,
    observation_kind: z.enum([
      'first_hand_player_experience',
      'expert_review',
      'editorial',
      'manufacturer_fact',
      'marketing',
      'discussion',
      'unknown',
    ]),
    review_status: z.enum([
      'staged',
      'rejected',
      'approved_for_analysis',
      'revoked',
    ]),
    evidence_basis: z.enum([
      'explicit_statement',
      'structured_source_field',
      'inferred',
      'unknown',
    ]),
    product_match: z.strictObject({
      catalog_product_id: z.uuid().nullable(),
      candidate_label: z.string(),
      confidence: z.number().min(0).max(1),
      method: z.enum([
        'exact',
        'alias',
        'model_number',
        'contextual',
        'unmatched',
      ]),
    }),
    sentiment: z.enum(['positive', 'negative', 'mixed', 'neutral', 'unknown']),
    topic: z
      .enum([
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
      ])
      .nullable(),
    explicit_rating: explicitRating.nullable(),
    player_type: playerType.nullable(),
    player_type_basis: z.enum(['explicit', 'unknown']),
    first_hand_confidence: z.number().min(0).max(1),
    model_version: z.string().nullable(),
    prompt_version: z.string().nullable(),
    source_content_hash: z.string().nullable(),
    independence_group_key: z.string().nullable(),
    rights_policy_id: z.string().min(1),
    quality_flags: z
      .array(z.string())
      .refine((a) => new Set(a).size === a.length),
    reviewer_id: z.string().nullable(),
    reviewed_at: timestamp.nullable(),
  })
  .superRefine((o, ctx) => {
    if (o.player_type && o.player_type_basis !== 'explicit')
      ctx.addIssue({
        code: 'custom',
        message: 'Player context requires explicit basis',
      });
    if (
      o.explicit_rating &&
      o.observation_kind !== 'first_hand_player_experience'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Ratings require first-hand evidence',
      });
  });
export type Observation = z.infer<typeof observation>;
export const sourceItem = z.strictObject({
  external_id: z.string().min(1).max(128),
  url: z.string(),
  published_at: timestamp,
  product_label: z.string().min(1).max(200),
  text: z.string().max(2000),
  experience_id: z.string().min(1).max(128),
  first_hand: z.boolean(),
  sponsored: z.boolean(),
  kind: z.enum(['player', 'editorial', 'manufacturer', 'discussion']),
  sentiment: z.enum(['positive', 'negative', 'mixed', 'neutral', 'unknown']),
  topic: observation.shape.topic,
  explicit_rating: explicitRating.nullable(),
  player_type: playerType.nullable(),
  would_recommend: z.boolean().nullable(),
  worth_the_price: z.boolean().nullable(),
});
export type SourceItem = z.infer<typeof sourceItem>;
export const decision = z.strictObject({
  action: z.enum(['approve', 'reject', 'revoke']),
  reason: z.enum([
    'verified_fixture',
    'insufficient_evidence',
    'ambiguous_product',
    'rights_concern',
    'sponsored',
    'duplicate',
    'takedown',
    'correction',
  ]),
  idempotency_key: z.string().min(8).max(128),
});
export type Decision = z.infer<typeof decision>;
export const exportManifest = z.strictObject({
  schema_version: z.literal('1.0'),
  batch_id: z.uuid(),
  produced_at: timestamp,
  environment: z.literal('fixture-local'),
  export_type: z.enum(['analysis_observations', 'explicit_rating_candidates']),
  count: z.number().int().nonnegative(),
  file_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_policy_ids: z.array(z.string()),
  evidence_types: z.array(z.string()),
  review_totals: z.record(z.string(), z.number()),
  unresolved_items: z.number().int().nonnegative(),
  synthetic: z.literal(true),
  authorization_actor: z.string().min(1),
});
