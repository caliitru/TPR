# Weekly incremental collection

The weekly runner extends the existing Phase 2/Source Registry collector. It has **not been deployed or started**. All execution remains mock-only; no candidate is activated by a schedule, migration or seed. Lovable and Supabase are outside this application.

## Schedule and execution

Default discovery closes at Sunday 02:00 **America/New_York**, regardless of the host timezone. The normal window is `[end - 168 hours, end)`. Weekly local calendar scheduling varies by one hour across DST: spring's nonexistent 02:00 executes at 03:00; fall executes once at 02:00. Coverage checkpoints close any gap caused by DST or missed executions. This is a weekly calendar schedule, rather than a fixed UTC hour.

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm seed
pnpm cli weekly-mock --reviewer local-admin
pnpm cli weekly-reports
# Manual stable window end; use the same timestamp for an idempotent rerun:
pnpm cli weekly-mock --source SOURCE_ID --until 2026-10-11T06:00:00Z --reviewer local-admin
# Separate, explicitly authorized, one-time five-calendar-year mock backfill:
pnpm cli backfill-mock --source SOURCE_ID --until 2026-10-11T06:00:00Z --authorize-backfill --reviewer local-admin
```

Only approved, enabled, unexpired sources are selected by default. Explicitly naming a disabled/unapproved source records a failure without sending a request. Mock policy and explicit mock activation are still required. No new live endpoint, credential or production export pathway exists.

The optional `pnpm scheduler:mock` worker refuses to start unless `TPR_WEEKLY_SCHEDULER_ENABLED=true`. **Do not start, install, deploy or enable it without separate operator authorization.** When explicitly started for local mock use, it polls once per minute, discovers the latest due Sunday slot, and runs each eligible source once per slot. Subsequent polls skip covered sources. Failed/deferred work resumes only when durable retry deadlines permit. Startup catches up a missed Sunday without a separate cron installation; SIGINT/SIGTERM stops the worker. It is never launched by installation, build, migration or cloud startup instructions.

## Window completeness and recovery

A source must support bounded discovery before participating. YouTube uses the official search date bounds; JSON adapters use `from`/`until` query parameters and follow pagination. Other sources require an explicitly verified `settings.window_support`: `bounded-api` for full historical interval queries or `complete-feed` for feeds guaranteed to include the entire requested interval. Recent-only feeds must not be declared complete. Missing capability fails closed. Five-year backfill requires YouTube date bounds or a bounded historical API; ordinary RSS feeds are rejected.

Client-side date checks also enforce the half-open interval. Records without publication dates are counted as undated and excluded; dates are never invented. A malformed response fails collection. Undated and out-of-window counts appear in reports, so coverage means completion of the authorized, dated discovery contract, not a claim about unavailable or undated material.

`collection_windows` stores kind, immutable interval, state, attempts, durable crawl-job identity, cursor, cumulative metrics, retry deadline and completion timestamp. Each source has at most one unfinished window across incremental and backfill work, enforced by a partial unique index. Session advisory locks also prevent simultaneous weekly/manual invocations for the source; the existing source lease protects against concurrent legacy collection. Locks automatically release on connection/process death. Checkpoints and the current job are persisted with ingestion pages, so a crash does not require replaying already committed pages.

A normal completed window advances `sources.weekly_covered_until` and `weekly_last_success_at`. Failure, partial pagination, quota deferral, loss of permission or an unfinished page never advance coverage. Next discovery starts at the earlier of seven days ago or the last covered boundary, including failed initial windows. Resuming an old unfinished window is followed by a catch-up window in the same invocation when possible. Backfill is separately identified, limited to one durable backfill per source and never substitutes for the weekly watermark.

Retries keep existing quota accounting, pacing, retry backoff and bounded transport attempts. A terminal job can be retried through a new audited attempt within the same window; the underlying source and observation identities remain global. No retry resets quotas, approvals or source suspension. Repeated complete window invocations return reused results with zero new counts and no source requests. Reports are stored for each explicit run; completed scheduler polling does not emit a report every minute.

## Historical deduplication and revisions

Migration `0006_weekly` adds database uniqueness for normalized source URLs, source content fingerprints, source experience IDs, identity aliases and independent experience/product/revision combinations. Existing source-specific external ID and URL constraints remain. All lookups cover the complete database with no seven-day cutoff, so backfill and weekly ingestion use the same identity space.

Canonical URL normalization removes fragments/tracking parameters, sorts query parameters and removes trailing slashes. Stable external IDs remain primary identity signals. Alias keys preserve previously seen IDs/URLs/content signatures when a record changes. Normalized evidence fingerprints omit publisher IDs and URLs, identifying exact repeated/syndicated evidence. Structured evidence changes produce a new evidence revision; no source body is stored.

`product_labels` optionally identifies multiple product mentions in one source item. Each canonical product receives its own observation identity, including after manual product correction; repeated aliases resolving to the same product do not create additional observations. Optional `experience_id` gives a stable source-scoped experience identity. Without reliable player identity, exact repeated evidence is conservatively considered the same experience, even across publishers; this can withhold independent but identically worded reports and requires source-specific evaluation before live use.

Revisions reuse the existing source item, revoke prior active observations with immutable review events, mark affected exports for retraction, and stage the changed evidence for review. Historical revoked revisions remain retained for audit; they are not additional active player experiences. Reapproval of a new policy still requires fresh moderation. Manufacturer facts stay in their separate pipeline; retailer records cannot produce player observations. Numeric player ratings are never inferred from sentiment.

Existing items are indexed by their stored external IDs and normalized URLs during migration. New fingerprint metadata cannot be reconstructed from old discarded source bodies; pre-upgrade cross-publisher syndication can only be recognized when reprocessed or supported by existing identity metadata. No previously approved evidence is silently merged or deleted. If historical rows collide under the stronger URL normalization, migration fails for explicit reconciliation rather than destroying data.

## Reports and verification

`pnpm cli weekly-reports` returns the latest 25 persisted reports. Each report includes sources checked, missed runs, new source records, new valid firsthand observations, all newly staged observations, duplicates skipped, existing records updated, ambiguous matches, moderation backlog, undated/out-of-window records, processing errors, failed sources/recovery states and the total historical observation count including revoked audit revisions. Source-level windows retain cumulative counts; report counters describe work done during that invocation, so completed reruns cannot inflate totals.

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm db:test:create
DATABASE_URL=postgresql://tpr_dev:tpr_dev_fixture_only@127.0.0.1:55432/tpr_ingestion_test pnpm test:all
```

Tests use mocks and local PostgreSQL. They verify DST boundaries, five-year windows, historical dedupe, direct database uniqueness violations, multi-product/syndication handling, audited updates, missed-week catch-up, partial-page recovery, concurrent exclusion, permission/expiry and timer idempotency alongside all earlier regression tests. No live scheduler deployment or real historical collection is part of validation.

A reproducible synthetic backfill/weekly/rerun demonstration is available after the tests:

```sh
DATABASE_URL=postgresql://tpr_dev:tpr_dev_fixture_only@127.0.0.1:55432/tpr_ingestion_test pnpm demo:weekly
```

This creates only a dedicated mock source in the disposable test database. It preserves existing source decisions on rerun, checks that repeated complete windows make zero additional requests, and prints persisted reports. It does not start the automatic scheduler.
