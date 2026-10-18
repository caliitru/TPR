import { z } from 'zod';
export const assessmentClass = z.enum([
  'approved_ready',
  'permission_verified_configuration_required',
  'commercial_agreement_required',
  'additional_terms_verification_required',
  'prohibited_current_use',
  'unavailable_unsupported',
]);
export const policyEvidence = z.strictObject({
  url: z.url().startsWith('https://'),
  attempted_at: z.iso.datetime(),
  outcome: z.enum([
    'retrieved_for_review',
    'proxy_connect_denied',
    'origin_denied',
    'redirect_requires_review',
    'network_error',
    'not_requested',
  ]),
  origin_status: z.number().int().nullable(),
  proxy_connect_status: z.number().int().nullable(),
  content_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  discovered_policy_links: z.array(z.url()).max(30),
  note: z.string().max(1000),
});
export const sourceAssessment = z.strictObject({
  source_id: z.string(),
  name: z.string(),
  source_url: z.url(),
  category: z.string(),
  classification: assessmentClass,
  checked_at: z.iso.datetime(),
  terms_verified_at: z.iso.datetime().nullable(),
  access_method: z.string(),
  commercial_rights: z.literal('unverified'),
  operations: z.strictObject({
    collection: z.literal('unknown'),
    analysis: z.literal('unknown'),
    derived_insights: z.literal('unknown'),
    storage: z.literal('unknown'),
    display: z.literal('unknown'),
  }),
  retention: z.literal('unverified; no collection authorization'),
  credentials_configured: z.boolean().nullable(),
  evidence: z.array(policyEvidence).max(5),
  missing_prerequisites: z.array(z.string()).min(1),
  questions: z.array(z.string()).min(1),
  eligible_for_pilot: z.literal(false),
});
export type PolicyEvidence = z.infer<typeof policyEvidence>;
export type SourceAssessment = z.infer<typeof sourceAssessment>;
