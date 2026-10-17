# Phase 2 implementation report

Baseline: `feat/fixture-intelligence` (`ef6d277`). Development branch: `feat/phase2-permitted-sources`. This extends the existing application rather than replacing it. All source requests described below use synthetic/mock responses; no real collection or deployment was activated.

## Implemented changes

- **Registry and policy controls:** `packages/contracts/sources.ts`, `packages/core/sources.ts`; disabled-by-default registration, source reconfiguration, versioned mock-only approvals, explicit mock enable, expiry/reapproval, schedules, persistent quota units/request spacing, health and immutable event history. Generic API, YouTube, RSS/Atom, manufacturer, forum and reserved approved-HTML source types are represented.
- **HTTP and adapters:** `packages/connectors/http.ts`, `external.ts`, `mock-scenarios.ts`; exact host policy, public-DNS validation/address pinning, retained TLS/SNI verification, no redirects/compression, timeout/size/count/page bounds, YouTube query/channel/product discovery and incremental pagination, RSS validators/304, manufacturer structured feeds/APIs, licensed forum/generic API JSON envelopes. Approved HTML is deliberately rejected until a source-specific parser is reviewed.
- **Collection:** `packages/core/collection.ts`; per-source leases, request accounting, atomic page/checkpoint persistence, idempotent jobs, bounded retries/dead letters, quota/spacing deferrals, scheduler tick, policy rechecks before requests and staging, duplicate/revision handling.
- **Intelligence and evidence:** `packages/core/intelligence.ts`, `evidence.ts`; curated brand/model aliases, generation/family/variant/configuration hints and multiple equipment categories, conservative ambiguity abstention, pluggable extraction provider, supported attribute spans/confidence, first-/second-hand classification and minimized hashed evidence. No hosted LLM is connected; provider output cannot create ratings/player context.
- **Operations:** `packages/core/operations.ts`; staged manual product corrections with idempotent immutable audit, curated catalog additions, manufacturer fact review and bounded metadata purge with replay-preventing tombstones/retractions.
- **Database:** migration pairs `0002_sources`, `0003_fact_revisions`, `0004_api_sources`, updated Drizzle schema and migration runner. Four new domain tables separate source events, request accounting, manufacturer fact revisions and observation evidence. Existing migrations remain unchanged/checksummed; downgrades refuse silent destruction of non-fixture sources or multiple fact revisions.
- **Admin/API/CLI:** source configuration, permission/health views, mock activation/collection, jobs/failures/retries, product correction, fact queue, eligible export preview and audit, purge; existing auth/role/origin/header controls retained. No live activation endpoint or command exists.
- **Documentation/CI/examples:** `docs/PHASE2-OPERATIONS.md`, README updates, `scripts/demo-phase2.ts`, expanded CI, and new unit/integration suites.

## Defects addressed

1. Phase 1 body-only hashes missed changed structured ratings/context. Hashes now include the normalized structured fixture record. Unchanged legacy body hashes upgrade only after retained structured evidence agrees, using an order-independent comparison; approval/history is preserved by that upgrade.
2. The fixture worker could otherwise claim a new external-source job. It now selects only fixture-source jobs.
3. External nullable publication dates remain null; no observation date is manufactured from collection time.
4. Product model identities are brand-scoped. Manufacturer revisions retain prior fact records and revoke stale versions rather than overwriting reviewed specifications.
5. Preview and actual exports share eligibility selection. Editorial analysis stays distinct from first-hand evidence; the explicit-rating stream still requires first-hand structured native integer 1–5 ratings, known context/answers, rights and approval.
6. Derived topic arrays use explicit JSON serialization for PostgreSQL. Per-page result counts advance only after the transaction commits.
7. Ordinary suspension and permanent takedown are distinct. Both suppress existing data/exports; permanent tombstones cannot be silently re-enabled.

8. The explicit safe value `PRODUCTION_EXPORT_ENABLED=false` is accepted by environment validation; true flags and production credential bindings remain forbidden.

## Actual verification

Before implementation: baseline lint, typecheck, build, **139 passing tests**, and Phase 1 demo.

After implementation:

| Check                                               | Actual result                                                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency installation                             | Passed with pinned pnpm lockfile and verification retained; added explicit `ipaddr.js` dependency                                                                                            |
| `pnpm lint`                                         | Passed                                                                                                                                                                                       |
| `pnpm typecheck`                                    | Passed                                                                                                                                                                                       |
| `pnpm build`                                        | Passed                                                                                                                                                                                       |
| `DATABASE_URL=.../tpr_ingestion_test pnpm test:all` | **211 passed, 0 failed, 0 skipped** across four suites                                                                                                                                       |
| Test breakdown                                      | 171 unit/contract cases; 40 isolated PostgreSQL/API integration cases                                                                                                                        |
| Migration down/up/up                                | Passed in the isolated test database, including new migrations                                                                                                                               |
| All new adapters                                    | Passed with mocked HTTP; unapproved, disabled, expired and live-mode-mismatched sources issue zero requests                                                                                  |
| Reliability                                         | Quota/spacing checkpoint continuation, conditional requests, concurrent leases, 429/500/timeout backoff, 403 shutdown, idempotent reviews, revisions, retention and retraction checks passed |
| HTTPS implementation                                | Low-level mocked request tests verified DNS pinning/SNI, TLS defaults, timeout, response-size and redirect rejection; no real sockets to sources                                             |
| Existing functionality                              | All original tests pass; original fixture demo and compiled HTTP smoke remain operational                                                                                                    |

The mock demo creates four explicitly approved **synthetic** sources. Its fresh behavior is:

```json
{
  "mode": "mock-only",
  "live_requests": 0,
  "youtube_discovery_observations": 2,
  "rss_editorial_observations": 1,
  "forum_observations": 2,
  "manufacturer_facts_in_separate_table": 1,
  "new_observations_on_repeat": 0
}
```

All fresh discovery/evidence enters staging. The demo reviewer explicitly approves one eligible synthetic forum observation and generates a local checksummed export. Previously approved Phase 0/1 observations can also be included; repeated demos preserve history and quotas. No unapproved discovery title becomes a player rating. The final example run is summarized in `docs/PHASE2-DEMO-RESULT.json`.

## Boundaries and remaining work

These results establish a functioning mocked collection foundation, not production readiness certification. All source policies accepted by the application are mock-only; `live_authorized=false` is enforced in the database and actual network flags remain false. No real-source rights, live credentials, deployment TLS/SSO, external-provider behavior, representative licensed extraction accuracy, or operational load has been validated. The forum/API adapter expects a documented licensed JSON envelope; it is not a generic website scraper. The rule extractor is conservative and uncalibrated, and human review does not verify real-world authorship automatically.

Before real activation: individually reviewed permission/retention/terms evidence, separately authorized runtime/egress/secret configuration, verified source-specific adapters, production deployment auth/observability and a separately reviewed release. Schedule the existing purge/scheduler operations operationally and validate downstream retraction acknowledgements. Real-source or Lovable publication remains outside this implementation.

**No Lovable project or Supabase database changes were made. No Consensus Score logic, production player signals, production credentials, real collectors or deployments were used.**
