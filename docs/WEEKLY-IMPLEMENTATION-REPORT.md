# Weekly incremental collection implementation

Baseline: Source Registry PR #3 (`09daf99`), with both prerequisite CI checks successful. Branch: `feat/weekly-incremental-collection`. No deployed service, real collector, Lovable connection or Supabase database is involved.

## Files and architecture

- `migrations/0006_weekly.up.sql` / `.down.sql`: database URL normalization and uniqueness, source fingerprints/experience keys/identity aliases, product-aware observation uniqueness, durable source windows, per-job metrics, coverage/success timestamps and persisted weekly reports. SQL remains authoritative for generated columns, expression/partial indexes and integrity constraints.
- `packages/core/weekly.ts`: New York calendar schedule, seven-day windows, five-year separate backfill, durable retries/catch-up, advisory source locks, one unfinished source window, source capability/permission enforcement and report generation.
- `packages/core/content-identity.ts`: canonical URLs and normalized evidence fingerprints; stable source-scoped experience identities and conservative cross-publisher syndication detection.
- `packages/core/collection.ts`: reuses existing collection leases, quotas, page transactions, moderation/audit/retraction logic; adds full-history identity resolution, atomic alias/upsert handling, per-product observations, committed-page checkpoints and metrics. Cursor restoration happens only after acquiring the existing collection lease.
- `packages/connectors/external.ts`, `mock-scenarios.ts`, `packages/contracts/sources.ts`: verified interval capabilities, bounded YouTube/API discovery, client-side date validation, optional product/experience IDs and window support. Existing unbounded/manual connector behavior remains available.
- `packages/db/schema.ts`, `migrate.ts`: schema metadata and checksummed migration registration.
- `apps/worker/cli.ts`, `weekly-scheduler.ts`, `package.json`, `.env.example`: manual weekly/backfill/report commands, explicitly disabled automatic mock worker, isolated weekly demo command and test commands. No deployment configuration or automatic worker launch is added.
- `tests/weekly-unit.test.ts`, `weekly-integration.test.ts`: schedule/DST, five-year boundaries, database dedupe, aliases/products/syndication, revisions, manual correction uniqueness, backfill overlap, retries, missed weeks, concurrency, crash/legacy lease behavior, window capability and permission regression checks.
- `scripts/demo-weekly.ts`, `.github/workflows/ci.yml`, `README.md`, `docs/WEEKLY-COLLECTION.md`: reproducible mock demonstration, CI execution and operator documentation.

## Safety and behavior

The default is Sunday 02:00 America/New_York; spring's missing hour resolves to 03:00. Normal discovery is a rolling 168-hour half-open window; coverage extends the start to recover missed intervals. Backfill uses a separate durable five-calendar-year interval and is never automatic. Both paths share all historical item/observation indexes and identity aliases.

Source permission, commercial-use restrictions, retention, expiration, rate limits, source enablement and review requirements remain enforced. Partial/failed requests do not advance coverage. Pagination/quotas defer durable jobs without discarding committed pages. Existing data changes follow the existing revocation/review audit and local export-retraction rules. All observations remain staged; no rating is inferred from sentiment.

The mock scheduler is off by default and has not been started or deployed. Optional future local startup requires an explicit operator flag. Complete-feed/bounded-API declarations require source-specific verification; ordinary recent-only feeds cannot claim historical coverage. A five-year collection is not attempted on sources without historical access.

## Validation and operational limitations

Local validation passed: frozen dependency install, `pnpm lint`, `pnpm typecheck`, `pnpm build`, compiled `pnpm smoke`, and **246 tests across seven files** (222 existing + 24 weekly checks: 8 unit and 16 integration). Migration down/up/up remains covered. The disabled-worker command was verified to exit before starting any worker.

The isolated `pnpm demo:weekly` demonstration produced:

| Metric                             | Five-year backfill | Weekly collection | Completed rerun |
| ---------------------------------- | -----------------: | ----------------: | --------------: |
| Sources checked                    |                  1 |                 1 |               1 |
| New source records                 |                  2 |                 1 |               0 |
| New valid player observations      |                  2 |                 1 |               0 |
| Duplicates skipped                 |                  0 |                 1 |               0 |
| Existing records updated           |                  0 |                 0 |               0 |
| Ambiguous matches                  |                  0 |                 0 |               0 |
| Newly awaiting moderation          |                  2 |                 1 |               0 |
| Failed sources / processing errors |                  0 |                 0 |               0 |
| Live requests                      |                  0 |                 0 |               0 |

The demo source retained three staged observations; the test database's reported historical total was four including one preceding test observation. The completed rerun made no additional requests. Separate integration tests exercised changed-record revision/audit, ambiguity/correction safeguards, multiple products, database collisions, transient failure recovery, partial pages and missed weeks. The test suite uses injected transport responses and isolated loopback PostgreSQL only; HTTP/HTTPS/fetch access is blocked in test setup. The synthetic demonstration explicitly requires `tpr_ingestion_test`, creates a dedicated mock source and checks reruns without resetting existing operator decisions.

Legacy IDs and normalized URLs are indexed during migration. Old discarded bodies cannot provide retrospectively reconstructed fingerprints; unknown pre-upgrade cross-publisher syndication requires reprocessing or independent identity evidence. Exact identical wording without reliable player identity is conservatively treated as one experience, potentially suppressing distinct identical reports. Historical revoked revisions remain audit records rather than active additional experiences. Existing normalized-URL collisions cause a migration failure requiring explicit reconciliation; no prior evidence is silently deleted.

Before any live use: source-specific historical API contracts and permissions, independent-experience evaluation, actual production scheduling/deployment approval, monitoring and per-person operational authentication remain required. No live network traffic, scheduler deployment or Lovable/Supabase changes were made.
