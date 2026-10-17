# Codex Implementation Backlog — standalone repository only

Implement one phase at a time; do not enable live connectors or external exports automatically. Require PR review per phase.

## Phase 0 — repo/bootstrap and hard guardrails (P0)

**Tasks:**

- Create private standalone TypeScript monorepo (`apps/api`, `apps/worker`, `apps/admin`, `packages/contracts`, `packages/core`, `packages/connectors`) with pnpm workspaces, formatting, linting, tests and CI.
- Local Docker Compose Postgres. No use of existing TPR credentials or database. Environment validation: forbid `PROD`, fail if any known production URL or token is provided; default network off.
- Drizzle migrations for isolated `sources`, `source_policies`, `crawl_jobs`, `source_items`, `catalog_products`, `product_aliases`, `observations`, `review_events`, `export_batches`, `tombstones`, `job_events`.
- Zod/JSON Schema contract; fixture-generated stable IDs; safe logging and secret masking.
- Basic developer docs; configure staging/outbound network disabled by default.

**DoD:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, migration up/down on local DB, sample data load and isolation guard tests pass. No connector enabled.

## Phase 1 — fixture-first vertical slice (P0)

**Tasks:**

- Build fixture connector implementing a common `Connector` interface (`discover`, `fetchMetadata`, `checkpoint`) without network.
- Normalize canonical URL/timestamps, compute stable item identity and dedupe.
- Load 5–10 synthetic products and alias/variant tests; explicit G440 family ambiguity rejection.
- Build rule-based evidence extractor and pluggable mock LLM adapter (no external LLM calls). Return unknown/null when evidence insufficient.
- Implement policy gate and staged observation repository; reviewer events and reason codes.
- Private HTTP API and minimal auth-protected reviewer UI; no content copying.
- Export approved observations to local `jsonl + manifest + sha256`; explicit-rating candidate export only for truly explicit ratings with known scale and rights.
- Create end-to-end regression suite and re-run idempotency proof.

**DoD:** 100+ synthetic test records, 3 fixture formats, observed 0 duplicates after 3 identical runs, reviewer audit trail, revocation suppresses export, all fixtures/tests pass; zero Lovable writes.

## Phase 2 — compliant connectors, one at a time (P1)

**Tasks:**

- Policy-review approval interface storing permission citation and authorized operation flags.
- General RSS/Atom connector for **explicitly approved** feeds; conditional GET ETag/Last-Modified; throttle and attribution.
- YouTube official API discovery-only adapter, contingent on current policy/terms/quotas; no unapproved transcript scraping or re-hosting.
- Manufacturer facts connector, only on approved terms; route facts separately from player observations.
- Optional permissioned forum adapter only after individual rights review; **do not build Reddit scraping** without separate authorization.
- Implement kill switches, policy expiry, IP/URL SSRF guard and robust rate limits.

**DoD:** Each connector has approved source policy, quota/retry tests, link attribution, deletion pathway; simulated disabled source makes zero requests. Owner sign-off before live use.

## Phase 3 — measurement and operational hardening (P1)

**Tasks:**

- Quality set: 100 labeled product matches, 100 first-hand vs promotional/second-hand classifications, 100 sentiment/topic cases (synthetic or licensed content).
- Evaluate precision/recall separately; manual review disagreement and abstain rate; calibrate confidence thresholds.
- Analytics dashboard: queued/completed/DLQ, per-source quota, extraction spend, rights compliance, false-positive corrections, review latency.
- Threat tests for malicious source HTML/prompt injection, retries/failures, PII retention, late takedowns and source revocation.
- Runbooks: incident response, source suspension, export retraction, key rotation, audit trace, cost emergency stop.

**DoD:** all quality/error/safety gates pass with documented benchmarks; no production writes.

## Phase 4 — FUTURE, requires user approval and separate plan (P2)

**Tasks:**

- Propose a versioned read-only integration boundary to Lovable, preferably a **new external-observations product lane** rather than existing player rating tables.
- Compare that against strictly curated explicit-rating CSV exports; preserve 25 approved signal eligibility and independent affiliate handling.
- Write migration and rollback proposal (do not execute), auth plan, proof of consensus non-contamination, legal signoff, human review requirements.

**DoD:** architectural approval and signed integration PRD; this handoff grants NO authorization to modify Lovable.

## Definition of done for every Codex PR

- Feature tests and typecheck pass; schema/migration changes documented and reversible.
- Permission and data lineage preserved. Null stays null when unknown.
- Security review includes outbound network, rights, PII and production isolation checks.
- No changes in existing Lovable project; no calls to production RPCs; no bypass of scoring rules.
- Include commands run and evidence in PR description.
