import { z } from 'zod';
import { sourceItem } from './index.js';
export const sourceDefinition = z.strictObject({
  source_id: z
    .string()
    .regex(/^[a-z][a-z0-9-]{2,79}$/)
    .refine((s) => !s.startsWith('fixture-')),
  name: z.string().min(1).max(120),
  type: z.enum([
    'youtube',
    'rss',
    'manufacturer',
    'forum',
    'approved-html',
    'api',
  ]),
  url: z.url().startsWith('https://'),
  interval_seconds: z.number().int().min(60).max(2592000).default(3600),
  daily_budget: z.number().int().min(1).max(10000).default(100),
  min_request_interval_ms: z.number().int().min(0).max(3600000).default(1000),
  settings: z.strictObject({
    allowed_hosts: z
      .array(z.string().regex(/^[a-z0-9.-]+$/))
      .min(1)
      .max(20),
    format: z.enum(['rss', 'atom', 'json']).default('json'),
    channels: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/))
      .max(20)
      .default([]),
    keywords: z.array(z.string().min(1).max(120)).max(20).default([]),
    products: z.array(z.string().min(1).max(120)).max(20).default([]),
    max_pages: z.number().int().min(1).max(10).default(3),
    api_key_env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,79}$/)
      .optional(),
  }),
});
export type SourceDefinition = z.infer<typeof sourceDefinition>;
export const policyApproval = z.strictObject({
  permission_reference: z.string().min(10).max(500),
  expires_at: z.iso.datetime({ offset: true }),
  scope: z.literal('mock'),
  operations: z.strictObject({
    discovery: z.boolean(),
    metadata: z.boolean(),
    derived_insights: z.boolean(),
    analyze_body: z.boolean(),
    manufacturer_facts: z.boolean(),
    export_analysis: z.boolean(),
    export_ratings: z.literal(false),
  }),
  metadata_days: z.number().int().min(1).max(365).default(30),
});
export type PolicyApproval = z.infer<typeof policyApproval>;
export const externalRecord = z.strictObject({
  external_id: z.string().min(1).max(128),
  url: z.url().startsWith('https://'),
  published_at: z.iso.datetime({ offset: true }).nullable(),
  title: z.string().max(300),
  body: z.string().max(20000).default(''),
  product_label: z.string().max(200).default(''),
  kind: z.enum(['discovery', 'editorial', 'player', 'manufacturer']),
  structured: sourceItem
    .pick({
      explicit_rating: true,
      player_type: true,
      would_recommend: true,
      worth_the_price: true,
      sponsored: true,
    })
    .partial()
    .default({}),
  facts: z
    .record(
      z.string().max(80),
      z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
  model: z.string().max(120).optional(),
  variant: z.string().max(120).optional(),
  release_date: z.iso.date().optional(),
});
export type ExternalRecord = z.infer<typeof externalRecord>;
export interface RegistrySource extends SourceDefinition {
  enabled: boolean;
  policy_id: string;
  status: string;
  scope: 'mock' | 'live';
  expires_at: Date | string;
  allowed_operations: Record<string, boolean>;
  retention: { metadata_days: number };
  etag: string | null;
  last_modified: string | null;
  discovery_state: Record<string, unknown>;
  last_success_at: Date | null;
  last_error_code: string | null;
  next_collection_at: Date | null;
}
