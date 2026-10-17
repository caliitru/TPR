# Build fixture-first TPR Content Intelligence ingestion and review service

The empty standalone repository now supports a complete synthetic ingestion workflow: six catalog products and JSON/CSV/RSS fixtures flow through conservative matching, evidence extraction and deduplication into a staged moderation queue. Authorized reviewers can approve/reject/revoke observations and explicitly produce checksummed local analysis and native 1–5 explicit-rating candidate artifacts.

Includes a Node.js 24/pnpm TypeScript workspace, isolated PostgreSQL/Drizzle schema and reversible migrations, durable fixture queue with bounded retries/DLQ/lease recovery, authenticated loopback API and minimal reviewer UI, immutable review audit, source-policy gates, tombstones, retraction inventory, CLI, CI and full reproduction docs.

Validation: frozen-lockfile installation, lint, typecheck, compiled build, 139 passing tests (120 unit/contract/matcher + 19 PostgreSQL/API integration), migration down/up and seed repeatability, complete demo and compiled HTTP smoke check. Three identical fixture ingestions yield 123 source items, 120 distinct observations and zero duplicate observation IDs. The fresh Ping G440 Max demo approves one observation, rejects another and writes one record in each authorized local export stream.

No Lovable/Supabase connections or changes, live source connectors, external inference, automatic publication or production deployment. Unknown ratings/context remain null. Synthetic exports must never be imported into production. Phase 2 requires per-source rights approval, live connector/SSRF/quota hardening and retention/deployment work; full evidence and limitations are in `docs/IMPLEMENTATION-REPORT.md`.
