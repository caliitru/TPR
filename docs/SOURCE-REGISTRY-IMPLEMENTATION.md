# Source Registry implementation report

Baseline: Phase 2 PR #2, `17efd1a477899cf490fb54baebd0ac2445e8b4ae`, branch `feat/phase2-permitted-sources`. Both GitHub validation checks were successful; PR #1 foundation was also open with passing checks. Feature branch: `feat/central-source-registry`, targeting the Phase 2 branch.

## Changes

- `0005_registry` reversible migration extends existing sources/policies with registry metadata, independent operational state, reviewed approval evidence and a unique scoped endpoint index. Existing migrations are unchanged. The database keeps operational state consistent with legacy enable/disable mutations.
- `packages/db/source-catalog.ts` contains all 43 requested disabled candidates. Explicit CLI seeding is transactional, serialized and idempotent; it preserves all existing decisions and appends source history only on first insertion.
- Existing source configuration and policy schemas now validate catalog category/domain, P1–P3 priority, proposed frequency, method/content/purpose declarations, commercial status, attribution, deletion policy, restrictions, notes and structured review evidence. Existing settings preserve YouTube channel/keyword/product discovery controls.
- Existing approval/activation flow requires verified source/commercial/access evidence for catalog sources, allowed method/content scope, reviewer, expiry and retention. Approval remains mock only and activation is separate. Reconfiguration invalidates prior permissions; suspension requires renewed policy review.
- Existing connector collection reads the same registry and policy for claims, requests and staging. Approved content scope is enforced before staging. Scheduler priority applies only to approved, active, unexpired sources. Existing quotas, pacing, leases, idempotency, retries, moderation and export boundaries remain in use.
- Retailer metadata never creates observations or ratings. Manufacturer data retains its separate Product Facts pipeline. Editorial metadata cannot be relabeled as firsthand player evidence.
- Existing Sources API/dashboard gains parameterized search/filtering, independent state labels, detailed policy/evidence/health display, notes/configuration editing through the existing configuration workflow, and existing collection/error/approval history.

## Catalog and permission status

43 catalog sources: 3 communities, 9 individual Reddit communities, 1 YouTube API, 16 manufacturers, 7 publications, 6 retailers and 1 TPR member-submission placeholder. All 43 start pending, commercial permission required and disabled; none has live authorization. Fixture seed adds 3 existing synthetic sources (46 total before optional mock demonstration sources).

Mock adapter implementations remain YouTube metadata, RSS/Atom, structured manufacturer JSON/feed, forum and generic JSON API, alongside local JSON/CSV/RSS fixtures. No source-specific Reddit, retailer, arbitrary HTML or member integration has been activated. All candidates require individual legal/commercial review and domain/API/feed verification. YouTube metadata processing still requires policy review; official API availability is not permission to repurpose videos, comments or descriptions.

## Verification

- Dependency installation: `pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store` succeeded without lockfile changes.
- Local catalog demonstration: first seed returned `{catalog_sources:43, inserted:43, live_enabled:false}`; second returned `{catalog_sources:43, inserted:0, live_enabled:false}`.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` and compiled `pnpm smoke` succeeded. The full `pnpm test:all` suite passed **222 tests** across five files: 171 existing unit tests, 40 existing integration tests and 11 new registry integration tests. Migration down/up/up regression passed. The fixture demo retained 123 source items, 120 observations and 12 unresolved product matches, and demonstrated approval/rejection of Ping G440 Max evidence plus validated local export. New integration coverage includes the complete catalog, concurrent idempotency, preserved operator state/history, scoped identity uniqueness, all disabled candidates making zero requests, commercial/evidence gates, independent activation, expiry, suspended enqueue prevention, unauthorized collection methods/content, retail scoring exclusion, filtered authenticated APIs and permission-gated priority scheduling.
- Fresh disposable-test-database `pnpm demo:phase2`, with all 43 candidates also seeded, completed all four synthetic adapters: 5 observations plus 1 separate manufacturer fact, zero new evidence on repeat, 1 approved local analysis export and **zero live requests**. The populated development database was preserved.
- Existing suites retain source-specific quotas/rate limits, manufacturer fact separation, first-hand/unknown evidence handling, fixture ingestion, review/export, deletion/retraction, SSRF/isolation and mock-only transport regression coverage. Test setup rejects external HTTP/HTTPS/fetch; only standalone local PostgreSQL is used.

## Remaining work

Domain/feed verification, actual permission evidence and attribution/retention agreements are intentionally pending. No catalog homepage is assumed to be a machine-readable endpoint. Source-specific response contracts, approved licensed/manual imports, Reddit commercial API, retailer feed normalization and member contracts need separate implementation and authorization. The TPR entry uses a reserved `.example` domain and never accesses Lovable. All live collection is hard-disabled, with no deployment or production integration. Historical local exports still require operator withdrawal when marked for retraction.
