import { sourceDefinition } from '../contracts/sources.js';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { transaction } from '../db/client.js';
import { sourceCatalog } from '../db/source-catalog.js';
import { requireActor, type Actor } from './moderation.js';
import { sourceEvent } from './sources.js';
import {
  sourceAssessment,
  type PolicyEvidence,
  type SourceAssessment,
} from '../contracts/source-assessment.js';
export function policyTargets(category: string, url: string) {
  if (category === 'tpr') return [];
  if (category === 'reddit')
    return [
      'https://redditinc.com/policies/data-api-terms',
      'https://redditinc.com/policies/user-agreement',
      'https://www.reddit.com/wiki/api/',
    ];
  if (category === 'youtube')
    return [
      'https://developers.google.com/youtube/terms/api-services-terms-of-service',
      'https://developers.google.com/youtube/terms/developer-policies',
    ];
  // Homepage navigation discovers the actual official legal links; guessed terms paths are not evidence.
  return [new URL(url).origin + '/'];
}
export function assessmentFromEvidence(
  def: (typeof sourceCatalog)[number],
  evidence: PolicyEvidence[],
  credentials: boolean | null,
  now = new Date(),
): SourceAssessment {
  const category = def.registry!.category;
  const prerequisites =
    category === 'reddit'
      ? [
          'Commercial Reddit API agreement and approved intended use; no unofficial scraping.',
          'Current Data API terms and subreddit-specific relevance/moderation scope.',
          'Secure client credentials and a reviewed source-specific adapter.',
        ]
      : category === 'youtube'
        ? [
            'Current YouTube API policies reviewed for discovery, commercial processing, attribution, retention and refresh/deletion.',
            'API key bound securely as TPR_YOUTUBE_API_KEY; an absent key must not be fabricated.',
            'Approved channels/queries, quota configuration and a bounded manual-only metadata grant.',
          ]
        : category === 'manufacturer'
          ? [
              'Verify official domain, authorized machine-readable product endpoint and release dates.',
              'Written license or explicit official terms covering commercial product-fact collection, retention, imagery references and display.',
            ]
          : category === 'community'
            ? [
                'Explicit forum-owner API/feed/license or individually written access permission.',
                'Rights to process and retain firsthand evidence, attribution/deletion obligations and participant privacy.',
              ]
            : category === 'editorial'
              ? [
                  'Official RSS/API endpoint and an explicit publisher license or terms permitting commercial metadata/derived use.',
                  'Article/photo/test-result reuse and firsthand classification must be separately established; RSS alone grants no commercial rights.',
                ]
              : category === 'retailer'
                ? [
                    'Retailer/affiliate feed agreement covering commercial price/inventory/product identity use.',
                    'Customer-review processing requires a separate explicit license; commerce never influences scoring.',
                  ]
                : [
                    'Separately approved TPR member integration contract, real development endpoint and member evidence rights.',
                    'No Lovable or live member database connection is authorized or configured.',
                  ];
  if (category !== 'tpr')
    prerequisites.unshift(
      evidence.some((e) => e.outcome === 'retrieved_for_review')
        ? 'Read the retrieved official document and record the exact applicable license clauses; HTTP retrieval is not authorization.'
        : 'Enable official-site policy research in the environment network settings; no current terms were retrieved.',
    );
  return sourceAssessment.parse({
    source_id: def.source_id,
    name: def.name,
    source_url: def.url,
    category,
    classification:
      category === 'tpr'
        ? 'unavailable_unsupported'
        : category === 'reddit'
          ? 'commercial_agreement_required'
          : 'additional_terms_verification_required',
    checked_at: now.toISOString(),
    terms_verified_at: null,
    access_method:
      category === 'youtube'
        ? 'Official YouTube Data API v3 (implementation exists; credentials and policy review pending)'
        : category === 'reddit'
          ? 'Official commercial API only; approval and adapter pending'
          : category === 'tpr'
            ? 'Reserved .example placeholder; no integration contract'
            : 'Official machine-readable endpoint unverified; policy navigation only',
    commercial_rights: 'unverified',
    operations: {
      collection: 'unknown',
      analysis: 'unknown',
      derived_insights: 'unknown',
      storage: 'unknown',
      display: 'unknown',
    },
    retention: 'unverified; no collection authorization',
    credentials_configured: credentials,
    evidence,
    missing_prerequisites: prerequisites,
    questions: [
      'Which exact terms/version grant TPR commercial collection, analysis, derived storage and display?',
      'What attribution, refresh, expiry, deletion and sublicensing limits apply to the intended operations?',
    ],
    eligible_for_pilot: false,
  });
}
export async function assessSources(
  db: Database,
  options: {
    actor: Actor;
    fetchPolicy: (
      url: string,
      allowedHosts: string[],
    ) => Promise<PolicyEvidence>;
    youtubeCredentialPresent: boolean;
    redditCredentialsPresent: boolean;
  },
) {
  requireActor(options.actor, true);
  const registered = (
    await db.pool.query(
      'SELECT source_id,name,type,url,registry,settings,interval_seconds,daily_budget,min_request_interval_ms FROM sources WHERE source_id=ANY($1::text[])',
      [sourceCatalog.map((s) => s.source_id)],
    )
  ).rows;
  if (registered.length !== sourceCatalog.length)
    throw new Error('Seed all 43 source candidates before assessment');
  const definitions = registered.map((row) => sourceDefinition.parse(row));
  if (definitions.some((row) => !row.registry))
    throw new Error('Catalog source registry metadata is required');
  const hosts = [
    ...new Set(
      sourceCatalog
        .filter((s) => s.registry!.category !== 'tpr')
        .flatMap((s) => [
          new URL(s.url).hostname,
          s.registry!.domain,
          'www.' + s.registry!.domain,
        ])
        .concat([
          'redditinc.com',
          'www.redditinc.com',
          'reddit.com',
          'www.reddit.com',
          'developers.google.com',
          'policies.google.com',
          'youtube.com',
          'www.youtube.com',
          'futureplc.com',
          'www.futureplc.com',
          'legal.futureplc.com',
        ]),
    ),
  ];
  const urls = [
    ...new Set(
      definitions.flatMap((s) => policyTargets(s.registry!.category, s.url)),
    ),
  ];
  const evidence = new Map<string, PolicyEvidence>();
  for (let index = 0; index < urls.length; index += 4) {
    await Promise.all(
      urls.slice(index, index + 4).map(async (url) => {
        try {
          evidence.set(url, await options.fetchPolicy(url, hosts));
        } catch {
          evidence.set(url, {
            url,
            attempted_at: new Date().toISOString(),
            outcome: 'network_error',
            origin_status: null,
            proxy_connect_status: null,
            content_sha256: null,
            discovered_policy_links: [],
            note: 'Research transport failed; current policy remains unverified.',
          });
        }
      }),
    );
  }
  const rows = definitions.map((s) =>
    assessmentFromEvidence(
      s,
      policyTargets(s.registry!.category, s.url).map((u) => evidence.get(u)!),
      s.registry!.category === 'youtube'
        ? options.youtubeCredentialPresent
        : s.registry!.category === 'reddit'
          ? options.redditCredentialsPresent
          : null,
    ),
  );
  const id = randomUUID();
  const products = (
    await db.pool.query(
      'SELECT product_id,slug,brand,name,category,type,catalog_snapshot_version FROM catalog_products ORDER BY brand,name LIMIT 15',
    )
  ).rows;
  const report = {
    assessment_id: id,
    created_at: new Date().toISOString(),
    source_count: rows.length,
    policy_navigation: {
      unique_requests_attempted: evidence.size,
      origin_documents_retrieved: [...evidence.values()].filter(
        (e) => e.outcome === 'retrieved_for_review',
      ).length,
      proxy_denied: [...evidence.values()].filter(
        (e) => e.outcome === 'proxy_connect_denied',
      ).length,
    },
    sources: rows,
    products: {
      requested_minimum: 10,
      available: products.length,
      selected: products,
      identity_status:
        'Existing records only; synthetic-v1 identities and release dates require independent verification. No products invented.',
    },
    real_external_collection: {
      status: 'blocked_no_verified_source_permissions',
      sources_contacted_for_data: [],
      endpoints_used_for_data: [],
      records_retrieved: 0,
      product_mentions: 0,
      valid_firsthand_observations: 0,
      manufacturer_facts: 0,
      duplicates_skipped: 0,
      awaiting_moderation: 0,
      observations: [],
    },
    mock_testing: {
      included_in_real_totals: false,
      synthetic_records_generated: 0,
    },
    scheduler_deployed: false,
    production_publication: false,
  };
  await transaction(db, async (c) => {
    await c.query(
      'INSERT INTO source_assessment_runs(assessment_id,actor_id,report) VALUES($1,$2,$3)',
      [id, options.actor.id, report],
    );
    for (const row of rows)
      await sourceEvent(
        c,
        row.source_id,
        options.actor.id,
        'source_access_assessed',
        {
          assessment_id: id,
          classification: row.classification,
          terms_verified: false,
          eligible_for_pilot: false,
        },
      );
  });
  return report;
}
