# Source Registry

The registry extends `sources`, `source_policies`, and immutable `source_events`; it does not introduce another source store or administration application. Phase 2 PR #2, commit `17efd1a`, was verified with both GitHub validation checks successful before this branch was created.

## Install and populate

Use Node 24, pnpm 11.25.0 and Docker, then run from the repository:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm seed
pnpm cli registry-seed --reviewer local-registry-admin
pnpm cli registry-seed --reviewer local-registry-admin
pnpm cli sources
pnpm lint
pnpm typecheck
pnpm build
pnpm db:test:create
DATABASE_URL=postgresql://tpr_dev:tpr_dev_fixture_only@127.0.0.1:55432/tpr_ingestion_test pnpm test:all
```

The first registry seed inserts 43 disabled candidates; the second inserts zero. It uses a transaction and advisory lock, preserves existing policy decisions/configuration/notes/suspension, and logs each initial insertion. Catalog seeding is explicit so existing fixture-only installations retain their original behavior. There are 46 sources after fixture seed plus catalog seed, before any optional mock demonstration sources.

All 43 catalog candidates have **pending permission**, **permission-required commercial use**, **disabled operation**, and no granted operations. None has been independently domain-verified or approved for collection. The TPR member source uses the reserved `theplayersroom.example` placeholder; it is not a Lovable endpoint.

| Category                 | Count | Priority | Permission review required                                               |
| ------------------------ | ----: | -------- | ------------------------------------------------------------------------ |
| Firsthand communities    |     3 | P1       | Individual licensed API/feed or written authorization                    |
| Reddit communities       |     9 | P1       | Commercial API access; no unofficial scraping                            |
| YouTube Data API         |     1 | P1       | API terms, approved metadata scope and commercial processing rights      |
| Manufacturers            |    16 | P1       | Official domains, feed/API availability and product-data/image licenses  |
| Publications             |     7 | P2       | Publisher feed/API/license and permitted editorial metadata scope        |
| Retailers                |     6 | P3       | Retail/affiliate agreement, pricing/inventory rights; no review scraping |
| TPR original submissions |     1 | P1       | Separate integration contract; no live member database access            |

The complete machine-readable catalog is [`packages/db/source-catalog.ts`](../packages/db/source-catalog.ts), including all requested named sources and nine individual subreddits. Shared domains may have distinct community/editorial scopes (The Hackers Paradise). A unique database index on category plus normalized endpoint prevents competing identities within a scope; source IDs are primary keys. Legacy duplicate endpoints cause migration failure rather than silent merging: an administrator must reconcile them before retrying.

## Review and operation

Use the existing private dashboard (`pnpm dev`, with the two local tokens documented in README). Its Sources section searches name, ID and domain and filters connector, priority, permission and operation. Inspect configuration, edit notes/settings, inspect policy evidence and expiration, review immutable approval/error/collection history, approve a mock policy and explicitly activate synthetic collection through the existing controls. `GET /sources` accepts `q`, `type`, `priority`, `approval`, and `operational` filters; unsupported parameters are rejected.

Configured, Approved and Actively Collecting are distinct. The latter two are explicitly labeled **mock only**. Permission state is stored on a versioned policy; operational state is independently disabled, active or suspended. Expired approval cannot authorize collection. Suspension requires reconfiguration/reapproval before activation. Reconfiguration always disables and resets permissions.

A candidate approval requires all of the following:

1. Administrator verifies source identity, commercial rights and API/feed access; sets registry commercial-use status to `approved` through disabled-source configuration.
2. Configuration identifies connector, allowed hosts/methods, approved content types, purposes, attribution, deletion rules, notes, schedule and request quotas/spacing.
3. Policy approval includes `registry_review` with `source_verified`, `commercial_use_verified`, and `access_verified` all true, `method`, HTTPS `evidence_links`, and nonempty `approved_content` limited to configured content types.
4. Existing approval fields identify the permission reference, expiration (maximum 366 days), approved operations and metadata retention (1–365 days; raw text zero).
5. A separate explicit **mock** activation is required. There is no live activation action. Neither commercial status nor registry membership enables collection.

Approval persists reviewer, timestamp, evidence, scope and policy version in existing policies and source history. Evidence URLs are stored for human review, never fetched. Do not put secrets or personal data in notes or evidence URLs. An approval here is a local mock policy, not a representation that actual commercial rights have been secured.

Only implemented API/feed methods can be approved; manual discovery, licensed file ingestion, member contracts and arbitrary authorized HTML require future source-specific adapters. YouTube channels, keywords and product queries remain configurable through existing `settings`. Generic JSON API/forum adapters require an agreed response contract; assigning a homepage does not implement a collector.

Manufacturer facts remain in Product Facts with independent moderation; they never become player observations. Retailer source items cannot create player observations. Editorial assessments remain distinct from firsthand experiences. Prices, commissions and affiliate relationships have no scoring input. No registry migration changes score calculations or publication/export authorization.

## Available implementations and limits

Existing implementations: local JSON/CSV/RSS fixtures; mocked YouTube metadata, RSS/Atom, structured manufacturer feeds/API, and licensed forum/generic JSON API. Approved HTML remains reserved and rejected. There is no Reddit scraper, transcript downloader, retailer-specific adapter or TPR member integration. All live transport remains hard-disabled, with loopback development PostgreSQL only; no Lovable or Supabase access occurs.

All 43 candidates require source-specific legal/commercial review, domain/feed verification, actual retention/attribution agreements and separate future authorization before live use. Priority orders due sources only after active, approved, unexpired policy checks; it cannot grant permissions. Retention purge and retraction tools remain those from Phase 2; historical local exports require operator withdrawal after retraction.
