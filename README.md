# The Players' Room — Content Intelligence

Standalone **fixture and mocked-external** ingestion and moderation service. Phase 2 extends the existing pipeline with permissioned source management, connector adapters, quotas, and a separate manufacturer-fact lane. See [Phase 2 operations](docs/PHASE2-OPERATIONS.md). No Lovable/Supabase client or automatic publication exists. The guarded HTTPS implementation is not activated by any application entry point. All sample reports, player contexts and ratings are synthetic test data. They must never be imported into the live website.

## Requirements and quick start

Node.js **24**, pnpm **11.25.0**, Docker Engine and Compose v2. All commands below run at the repository root. On a machine without pnpm, enable Corepack or install the pinned pnpm version through your normal package manager.

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm seed
pnpm demo
pnpm demo:phase2                      # mocked YouTube, RSS, manufacturer and forum HTTP
```

In the cloud sandbox, use `pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store` to keep the package store writable. The install only permits esbuild's required build script. Dependencies and integrity hashes are pinned in `pnpm-lock.yaml`.

`demo` migrates/seeds without resetting existing data, ingests all fixtures **three times**, stages observations, approves one eligible observation, rejects another, and explicitly authorizes two **local** export batches. It is a scripted synthetic reviewer, not an automatic production moderator. On a fresh database it yields **6 products, 123 source items, 120 distinct observations, 12 ambiguous products, zero duplicate observations**, one approved and one rejected review. Reruns preserve previous decisions and add another pair of decisions where pending candidates remain; totals of approved exports can therefore grow.

The canonical example is **Ping G440 Max Driver**, alongside G440 SFT/LST, G430 Max, Titleist GT2 and TaylorMade Qi35. A bare “Ping G440” abstains. Only full names, curated aliases or exact model identifiers match; no fuzzy family guessing.

## Run and inspect manually

```sh
pnpm ingest                         # all three fixture sources, new run key
pnpm cli ingest --key sample-run-0001  # repeating this key enqueues no extra jobs
pnpm cli jobs
pnpm cli list
pnpm cli review --id OBSERVATION_UUID --action approve --reason verified_fixture --reviewer local-reviewer --key unique-review-0001
pnpm cli review --id ANOTHER_UUID --action reject --reason insufficient_evidence --reviewer local-reviewer --key unique-review-0002
pnpm cli export --reviewer local-reviewer --authorize-local-export --type analysis_observations
pnpm cli export --reviewer local-reviewer --authorize-local-export --type explicit_rating_candidates
```

Replace the UUID placeholders with `observation_id` values from `list`. Approval requires a matched, first-hand, unsponsored observation with no quality flags and a currently valid source policy. Unknown numeric/context fields stay null. CLI administration trusts access to the local OS/database; `--reviewer` records operator attribution and does not replace an authentication system.

Batches live in ignored `artifacts/<batch-id>/`: `observations.jsonl`, `manifest.json`, and `sha256.txt`. Rating batches also contain `rating-candidates.csv` and its checksum. Check a batch with `cd artifacts/BATCH_ID && sha256sum -c sha256.txt`. JSONL contracts and the native 1–5 rating-candidate shape are validated before writing. CSV columns match the handoff's TPR import boundary, **but compatibility has not been verified against live TPR and synthetic CSV must not be imported**.

General sentiment never becomes a rating. The rating stream additionally requires an explicit structured rating on a native integer 1–5 scale, explicit player bucket, explicit recommendation and price-worth answers, rights, and review. No normalization of a ten-point/five-star-zero-origin scale, guessed booleans, or inferred handicap is permitted.

## Private reviewer API and UI

Generate fresh distinct tokens in your shell (never paste tokens into source or chat):

```sh
export TPR_REVIEWER_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
export TPR_ADMIN_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
pnpm dev
```

The service binds only to loopback port **4310**. Open the `/admin` path locally; HTTP Basic accepts any username and the reviewer/admin token as password. A secret manager/password manager can supply that token without logging it. Bearer authentication is available for API clients. The interface paginates metadata, source attribution, quality flags and review history, supports approve/reject/revoke, and lets an admin explicitly authorize a local export. It renders text with `textContent` and retains no article bodies or tokens in browser storage. No cloud preview is provided.

Mutations require JSON and `X-TPR-Review: 1`; cross-origin browser mutations are rejected. Do not expose this development HTTP service publicly. Role identities are `api-reviewer` and `api-admin`; per-person SSO/TLS and stronger deployment authorization are future work.

| Endpoint                                            | Access / behavior                                        |
| --------------------------------------------------- | -------------------------------------------------------- |
| `GET /health`                                       | Unauthenticated, verifies DB connectivity                |
| `GET /sources`                                      | Authenticated source/policy metadata                     |
| `POST /runs/fixtures`                               | Admin; `{ "idempotency_key": "unique-run-0001" }`        |
| `GET /jobs/:id`                                     | Authenticated job state/attempts                         |
| `GET /observations?status=staged&limit=25&offset=0` | Authenticated paginated observations                     |
| `GET /observations/:id/history`                     | Authenticated immutable audit history                    |
| `POST /observations/:id/decision`                   | Reviewer/admin; `action`, `reason`, `idempotency_key`    |
| `POST /exports/preview`                             | Counts only; no authorization granted                    |
| `POST /exports/generate`                            | Admin; `authorize_local_export: true`, `type`            |
| `GET /exports/retractions`                          | Batches no longer safe to consume                        |
| `POST /sources/:id/disable`                         | Admin; stops source and suppresses existing observations |
| `POST /takedowns`                                   | Admin; `item_id`, `reason`                               |

Review reason codes: `verified_fixture`, `insufficient_evidence`, `ambiguous_product`, `rights_concern`, `sponsored`, `duplicate`, `takedown`, `correction`. Only staged→approved/rejected and approved→revoked are reviewer transitions. Review idempotency keys bind actor, observation and decision; conflicts fail. Database triggers forbid updating/deleting review history.

## Validation

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm db:test:create
DATABASE_URL=postgresql://tpr_dev:tpr_dev_fixture_only@127.0.0.1:55432/tpr_ingestion_test pnpm test:integration
# Or run both test suites, with the disposable test DB explicitly selected:
DATABASE_URL=postgresql://tpr_dev:tpr_dev_fixture_only@127.0.0.1:55432/tpr_ingestion_test pnpm test:all
```

Integration tests **truncate only the explicitly named `tpr_ingestion_test` database**. They test migration down/up, three-run idempotency, full ingestion/review/export, concurrency, job retries/leases, policy expiry, takedowns, audit immutability, authentication and CSRF. HTTP/HTTPS requests and fetch are disabled in test setup; only local PostgreSQL uses a socket. Tests inject 429/403/500/timeout failures without calling remote hosts. The 100-case matcher regression is ten labeled cases with casing/spacing variations, not a real-world accuracy benchmark.

`pnpm smoke` starts the compiled API, checks DB health, authentication, the queue and private UI over loopback HTTP, then stops that process. Run it after `pnpm build` and the demo.

Compiled execution is supported: `node dist/apps/worker/cli.js list` and, with tokens set, `node dist/apps/api/server.js`. `build` copies fixture, migration and UI assets beside the compiled modules.

## Architecture

| Location              | Responsibility                                                                          |
| --------------------- | --------------------------------------------------------------------------------------- |
| `apps/worker`         | Operator CLI and durable fixture job execution                                          |
| `apps/api`            | Loopback API, auth, role/CSRF gates                                                     |
| `apps/admin`          | Minimal private review interface                                                        |
| `packages/contracts`  | Strict Zod observation/source/review/export contracts                                   |
| `packages/connectors` | Common discover/fetchMetadata/checkpoint interface; JSON, CSV, RSS fixtures only        |
| `packages/core`       | Isolation, source policy, product matching, extraction, dedupe, moderation, retry queue |
| `packages/db`         | Drizzle schema/migration executor, PostgreSQL transactions, fixture seed                |
| `packages/adapters`   | Authorized local JSONL/manifest/checksum/CSV boundary                                   |
| `migrations`          | Reversible isolated SQL schema with integrity checksum                                  |
| `contracts`           | Original JSON Schema and disabled example live-source configuration                     |
| `fixtures`            | Synthetic catalog plus 123 input records in three formats                               |

The original 12 domain tables model sources/policies, jobs/events, items, catalog/aliases, observations/reviews, exports and tombstones. Migration execution uses Drizzle transactions, a PostgreSQL advisory lock and a recorded SHA-256 checksum. SQL is authoritative for check constraints, unique indexes and the append-only audit trigger. Queries use parameterized PostgreSQL transactions; no ORM-generated mutation reaches another database.

Jobs claim rows with `SKIP LOCKED`, commit an entire fixture batch and checkpoint atomically, retry at most three times with exponential delay, and expose a dead-letter state. A crashed worker's 30-second lease is reclaimable. `pnpm cli work` drains due jobs; rerun it after a retry's due time. There is no always-on scheduler in this phase. Unique keys and fingerprints preserve idempotency under concurrent workers. Invalid records create reason-code events without retaining raw content. Revised source bodies are quarantined for a separate review, rather than silently changing approved evidence.

An independence key groups a trusted **synthetic experience**, not a real person. Mirrored fixture records share that key across sources and are deduplicated; separate experiences with identical sentiment are preserved. This is not real-world identity verification, fuzzy syndication detection, or a calibrated LLM. `MockEvidenceAdapter` is injectable and deterministic; it never makes an external inference call. Source-provided fixture metadata supports sentiment/topics, while explicit first-person use is required for first-hand classification.

## Isolation, revocation and operations

- Only loopback PostgreSQL `tpr_ingestion_dev`/`tpr_ingestion_test` using the `tpr_dev` role is accepted. URL query overrides, remote hosts, Supabase/production bindings and production mode fail closed.
- `NETWORK_ENABLED`, `CONNECTOR_ENABLED`, and `PRODUCTION_EXPORT_ENABLED` must remain false. Only built-in fixture connectors exist. Fixture URLs are restricted to `https://fixtures.example.org`; they are never fetched.
- Fixture policies are explicitly marked as synthetic-only; no live source is approved. Policy expiry/disable/revocation is checked before discovery, approval and every export.
- Sources start disabled at the schema level; the seed enables only the three fixture sources. Repeated seed calls **do not re-enable** disabled/revoked sources or overwrite reviewer decisions.
- Raw source bodies and author handles are not retained. Safe job logs contain IDs/counts/codes only. Local Compose credentials are intentionally fixture-only; no production secret is accepted.

Suppress an item/source and inspect export retractions:

```sh
pnpm cli suppress --item ITEM_UUID --reason takedown --reviewer local-reviewer
pnpm cli suppress --source fixture-json --reason source_disabled --reviewer local-reviewer
pnpm cli retractions > artifacts/retractions.json
```

Tombstones suppress replay; review events capture revocation and affected batches are marked `retraction_required`. Already-created artifacts are immutable historical files: withdraw/delete copies and deliver the retraction list to any local downstream consumer. The service does not reach into other systems or promise remote deletion. Full retention/purge automation and deployment key rotation are Phase 2/3 work.

`pnpm db:down` stops services while preserving the volume. Rollback refuses to discard non-fixture sources or multiple fact revisions; preserve local work before a schema downgrade. A destructive rollback of a fixture-only database is guarded: `ALLOW_LOCAL_RESET=yes pnpm db:rollback`, then `pnpm db:migrate` restores the empty schema. **Rollback deletes local ingestion data.** Never run integration/reset commands against a populated dev database you wish to preserve.

## Scope and remaining work

Phase 0/1 delivers the synthetic vertical slice, including a minimal reviewer UI rather than a frontend framework, a PostgreSQL queue rather than Redis, and explainable fixture rules rather than a hosted LLM. No deployment or production integration is included. Phase 2 implements the source UI, mocked connector adapters, DNS/SSRF/response bounds, persistent quotas and metadata purge controls. Before live data, source-by-source permission review and separate activation approval, licensed evaluation, per-person deployment authentication, and operational hardening are still required. No Reddit scraping or transcript downloader exists.

The original requirements are preserved in `docs/TPR-TECHNICAL-AUDIT-AND-INGESTION-ARCHITECTURE.md`, `AGENTS.md` and `tasks/IMPLEMENTATION-BACKLOG.md`. The archived `docs/CODEX-START-PROMPT.md` has an older Phase-0-only stopping point; the current user instruction authorized Phase 0 and Phase 1 together. No Lovable project, Supabase database, scoring function, Consensus Score or production player signal has been changed.
