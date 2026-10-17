# Phase 0 and Phase 1 implementation evidence

Implemented in `caliitru/TPR` on `feat/fixture-intelligence`. The repository was intentionally empty; an empty initial commit establishes `main` as a PR base. All application changes are on the feature branch.

## Delivered files and architecture

- Workspace/tooling: root package and lockfile, pnpm workspaces, strict TypeScript, ESLint/Prettier, environment example, Docker Compose, GitHub Actions.
- `packages/contracts`: strict Zod observation, transient source, review and export contracts; original JSON contracts retained in `contracts`.
- `packages/db` and `migrations`: 12 domain tables, Drizzle schema and transactional reversible/checksummed migrations, parameterized PostgreSQL repository operations and repeatable fixture seed.
- `packages/connectors`: network-free JSON, CSV and RSS implementations of discover/fetchMetadata/checkpoint.
- `packages/core`: loopback/production guard, source policy gate, conservative catalog matcher, structured fixture extraction, independent-experience fingerprints, durable jobs with leases/retries/DLQ, moderation and tombstones.
- `packages/adapters`: authorized local analysis JSONL and explicit-rating candidate JSONL/CSV, manifests and SHA-256 checksums, retraction inventory.
- `apps/worker`: CLI for setup, ingestion, job/queue inspection, review, suppression and exports.
- `apps/api` and `apps/admin`: authenticated loopback API and minimal paginated reviewer UI, CSRF/role gates, review history.
- `fixtures`: six synthetic products and 123 source records in three formats. No real player reports or source bodies were collected.
- `scripts`: migrations, isolated test-DB creation, complete demo, static build assets, compiled HTTP smoke check.
- `tests`: 120 unit/contract/matcher cases and 19 PostgreSQL/API integration cases.
- `README.md`: all reproduction commands, operator workflow, safety boundaries, API documentation, revocation and reset procedures.

The implementation uses a PostgreSQL job queue instead of Redis, a minimal private UI instead of a frontend framework, and deterministic fixture rules/mock inference instead of an external LLM. Dependencies live at the workspace root. These choices keep the first vertical slice small and independently runnable.

## Executed validation

| Command/check                                                       | Result                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store` | Passed; integrity/supply-chain policy checks retained, esbuild build explicitly allowed                                                    |
| `pnpm db:up`                                                        | PostgreSQL 17 healthy, loopback port 55432                                                                                                 |
| `pnpm db:migrate`                                                   | Passed; repeatable migration application                                                                                                   |
| Migration down/up/up + seed twice                                   | Passed against isolated test DB                                                                                                            |
| `pnpm lint`                                                         | Passed                                                                                                                                     |
| `pnpm typecheck`                                                    | Passed                                                                                                                                     |
| `pnpm build`                                                        | Passed; fixture/migration/UI assets copied for compiled execution                                                                          |
| `DATABASE_URL=.../tpr_ingestion_test pnpm test:all`                 | **139 passed, 0 failed, 0 skipped**                                                                                                        |
| `pnpm demo`                                                         | Passed against standalone development DB                                                                                                   |
| `pnpm smoke`                                                        | Compiled server started; real loopback HTTP health, unauthorized denial, authorized queue and private UI passed; process stopped afterward |

The matcher regression contains ten base labeled cases with formatting/case variants (100 assertions). It demonstrates conservative fixture behavior, not representative production precision. Reliability tests inject 429, 403, 500, timeout and expired leases; no real external requests are made.

## Fresh demonstration

```json
{
  "synthetic": true,
  "products": 6,
  "fixture_sources": 3,
  "identical_ingestion_runs": 3,
  "completed_jobs": 9,
  "source_items": 123,
  "distinct_observations": 120,
  "duplicate_observations": 0,
  "ambiguous_product_observations": 12,
  "staged_after_review": 118,
  "approved_for_analysis": 1,
  "rejected": 1,
  "reviewed_example": "Ping G440 Max Driver",
  "analysis_export_count": 1,
  "explicit_rating_candidate_count": 1
}
```

The explicit candidate has a **synthetic structured 4/5 rating** and explicitly supplied player context/recommendation/value fields. Unrated positive sentiment remains unrated; non-native scales, fractional ratings, missing player context or unknown booleans do not enter the rating export. Approved/rejected review events are immutable and idempotent. Policy disable/expiry/revocation, policy-version drift, quality failures and tombstones all suppress export. Changed approved evidence is revoked with an audit entry and existing batches are flagged for retraction.

Current local artifacts are under ignored `artifacts/<batch-id>/`; database state and artifacts are not committed. Re-running the demo preserves history and can approve/reject another pair, so subsequent export counts can increase.

## Delivery and limitations

The initial `main` commit was pushed successfully. Git transport works, but `api.github.com` is denied by the environment egress proxy (HTTP CONNECT 403), so automatic PR creation needs GitHub API network access. A complete PR description is included in `docs/PR-DESCRIPTION.md`.

This is a tested fixture-only service, not a production deployment. CLI attribution trusts local OS access; the private API has shared development role tokens rather than per-person SSO. The worker drains currently due jobs and is invoked again for delayed retries. Near-duplicate real text, trustworthy live first-hand identity, retention purge automation, production-grade telemetry, live policy activation and deployed secrets/TLS remain future work. PostgreSQL/filesystem artifact publication cannot be fully atomic across a machine crash: inspect batch registration and remove orphan temporary/artifact directories before downstream use after an interrupted export. Existing artifact copies require explicit withdrawal when a retraction is reported.

## Phase 2 next tasks

1. Add a reviewed source-policy activation interface with permission citation, expiry, operation flags and operator approval.
2. Implement approved RSS/Atom and official discovery-only API connectors one at a time, disabled by default; no Reddit scraping or unapproved transcripts.
3. Add per-source quotas, conditional requests, timeouts, response-size limits and DNS/redirect-aware SSRF protection before any live access.
4. Implement policy-specific retention/purge/deletion and validate takedown delivery to downstream consumers.
5. Evaluate matching/extraction against independently labeled licensed data and strengthen deployment auth/observability before operational release.

No Lovable project/database changes were made. No Supabase connection, production credential, production write, score recalculation, real-source collection or deployment occurred. All exports remain local synthetic artifacts and must not be imported into live TPR.
