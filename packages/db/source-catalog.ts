import {
  sourceDefinition,
  type SourceDefinition,
} from '../contracts/sources.js';
import { transaction, type Database } from './client.js';
import { sourceEvent } from '../core/sources.js';
import { requireActor, type Actor } from '../core/moderation.js';

const groups = {
  community: [
    ['GolfWRX Forums', 'forums.golfwrx.com'],
    ['MyGolfSpy Forums', 'forum.mygolfspy.com'],
    ['The Hackers Paradise Community', 'thehackersparadise.com'],
  ],
  manufacturer: [
    ['PING', 'ping.com'],
    ['TaylorMade', 'taylormadegolf.com'],
    ['Callaway', 'callawaygolf.com'],
    ['Titleist', 'titleist.com'],
    ['Cobra Golf', 'cobragolf.com'],
    ['Mizuno Golf', 'mizunogolf.com'],
    ['Srixon', 'srixon.com'],
    ['Cleveland Golf', 'clevelandgolf.com'],
    ['Scotty Cameron', 'scottycameron.com'],
    ['Odyssey Golf', 'odysseygolf.com'],
    ['Garmin', 'garmin.com'],
    ['Bushnell Golf', 'bushnellgolf.com'],
    ['FlightScope', 'flightscope.com'],
    ['Foresight Sports', 'foresightsports.com'],
    ['Rapsodo', 'rapsodo.com'],
    ['SkyTrak', 'skytrakgolf.com'],
  ],
  editorial: [
    ['MyGolfSpy', 'mygolfspy.com'],
    ['GolfWRX', 'golfwrx.com'],
    ['Golf Monthly', 'golfmonthly.com'],
    ["Today's Golfer", 'todays-golfer.com'],
    ['Golf Digest', 'golfdigest.com'],
    ['Golf.com', 'golf.com'],
    ['The Hackers Paradise', 'thehackersparadise.com'],
  ],
  retailer: [
    ['PGA TOUR Superstore', 'pgatoursuperstore.com'],
    ['Golf Galaxy', 'golfgalaxy.com'],
    ['GlobalGolf', 'globalgolf.com'],
    ['2nd Swing', '2ndswing.com'],
    ["Carl's Golfland", 'carlsgolfland.com'],
    ['Worldwide Golf', 'worldwidegolf.com'],
  ],
} as const;
type Category = NonNullable<SourceDefinition['registry']>['category'];
function entry(
  name: string,
  domain: string,
  category: Category,
  url = `https://${domain}/`,
) {
  const manufacturer = category === 'manufacturer',
    retailer = category === 'retailer';
  return sourceDefinition.parse({
    source_id: `catalog-${category}-${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-$/, '')}`,
    name,
    url,
    type: manufacturer
      ? 'manufacturer'
      : category === 'youtube'
        ? 'youtube'
        : category === 'community'
          ? 'forum'
          : category === 'editorial'
            ? 'rss'
            : 'api',
    interval_seconds: retailer ? 21600 : 86400,
    daily_budget: 100,
    min_request_interval_ms: 1000,
    settings: {
      allowed_hosts:
        category === 'youtube'
          ? ['www.googleapis.com', 'www.youtube.com']
          : [new URL(url).hostname],
      format: category === 'editorial' ? 'rss' : 'json',
    },
    registry: {
      category,
      domain,
      priority: retailer ? 'P3' : category === 'editorial' ? 'P2' : 'P1',
      collection_methods:
        category === 'reddit'
          ? ['official-api', 'manual-discovery']
          : category === 'tpr'
            ? ['member-contract']
            : category === 'youtube'
              ? ['official-api']
              : [
                  'official-api',
                  'official-feed',
                  'licensed-dataset',
                  'authorized-page',
                ],
      content_types: manufacturer
        ? ['product-facts']
        : retailer
          ? ['pricing', 'inventory', 'product-identity']
          : category === 'youtube'
            ? ['discovery-metadata']
            : category === 'editorial'
              ? ['editorial-metadata']
              : ['firsthand-experience', 'product-discovery'],
      purposes: manufacturer
        ? [
            'Canonical names, variants, specifications, releases, MSRP and authorized imagery references',
          ]
        : retailer
          ? [
              'Pricing, availability, offers and identity enrichment; never scoring',
            ]
          : category === 'youtube'
            ? [
                'Golf equipment discovery across clubs, technology, apparel and accessories',
              ]
            : category === 'editorial'
              ? [
                  'Launch discovery, testing references, comparisons and release monitoring',
                ]
              : [
                  'Ownership, fitting, performance, comparisons, durability and buying context',
                ],
      commercial_use: 'permission-required',
      api_availability:
        category === 'youtube'
          ? 'official-api'
          : category === 'reddit' || category === 'tpr'
            ? 'contract-required'
            : 'unverified',
      attribution:
        'Preserve source name, canonical URL, collection date and approved attribution; verify exact terms before approval.',
      deletion_policy:
        'No raw body retention. Purge metadata on policy expiry; honor source takedowns and export retractions.',
      restrictions: [
        'All live collection disabled; candidate listing grants no permission.',
        ...(manufacturer
          ? [
              'Product Facts only; manufacturer claims cannot increase Player Consensus.',
            ]
          : retailer
            ? [
                'No customer review collection; pricing, commissions and affiliate offers never influence scoring.',
              ]
            : category === 'reddit'
              ? [
                  'Commercial access approval required; no unofficial scraping or bypasses.',
                  'Marketplace, advice and watch discussions require relevant verifiable equipment experience.',
                ]
              : category === 'youtube'
                ? [
                    'Metadata discovery only; no transcripts, downloads or assumed description/comment rights.',
                    'Titles and views are not endorsements or ratings.',
                  ]
                : category === 'tpr'
                  ? [
                      'Separate integration contract required. No Lovable or member database access.',
                    ]
                  : [
                      'Verify domains and authorized feeds before activation. No copyrighted republication.',
                    ]),
      ],
      notes:
        'Unverified candidate supplied by TPR; approval, scope and rate limits require individual review.',
    },
  });
}
export const sourceCatalog: SourceDefinition[] = [
  ...Object.entries(groups).flatMap(([category, entries]) =>
    entries.map(([name, domain]) => entry(name, domain, category as Category)),
  ),
  ...[
    'golf',
    'golfclassifieds',
    'GolfGear',
    'golftips',
    'golfwrx',
    'golf_simulators',
    'Garmin',
    'GarminWatches',
    'AppleWatch',
  ].map((name) =>
    entry(
      `r/${name}`,
      'www.reddit.com',
      'reddit',
      `https://www.reddit.com/r/${name}/`,
    ),
  ),
  entry(
    'YouTube Data API',
    'youtube.com',
    'youtube',
    'https://www.googleapis.com/youtube/v3/search',
  ),
  entry('TPR Member Submissions', 'theplayersroom.example', 'tpr'),
];
/** Explicit catalog seed: preserves every existing configuration and permission decision. */
export async function seedSourceCatalog(db: Database, actor: Actor) {
  requireActor(actor, true);
  return transaction(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(717441)');
    let inserted = 0;
    for (const def of sourceCatalog) {
      if (
        (
          await c.query('SELECT 1 FROM sources WHERE source_id=$1', [
            def.source_id,
          ])
        ).rowCount
      )
        continue;
      const policy = `${def.source_id}-pending-v1`;
      await c.query(
        `INSERT INTO source_policies(policy_id,status,allowed_operations,permission_reference,reviewed_by,reviewed_at,expires_at,retention,scope) VALUES($1,'pending','{}','Unverified candidate; commercial permission required',$2,now(),now(),'{"raw_text_hours":0,"metadata_days":30}','mock')`,
        [policy, actor.id],
      );
      await c.query(
        `INSERT INTO sources(source_id,name,type,url,settings,interval_seconds,daily_budget,min_request_interval_ms,policy_id,registry) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          def.source_id,
          def.name,
          def.type,
          def.url,
          def.settings,
          def.interval_seconds,
          def.daily_budget,
          def.min_request_interval_ms,
          policy,
          def.registry,
        ],
      );
      await sourceEvent(
        c,
        def.source_id,
        actor.id,
        'registry_candidate_seeded',
      );
      inserted++;
    }
    return {
      catalog_sources: sourceCatalog.length,
      inserted,
      live_enabled: false,
    };
  });
}
