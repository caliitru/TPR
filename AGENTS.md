# AGENTS.md — TPR Ingestion Service

You are building a **new, separate repository**, NOT editing the Lovable app.

## Non-negotiable rules

1. **Do not write to, migrate, deploy, run mutation calls against, or reconfigure the existing Lovable project `c7736b82-13bd-4687-a645-a86e46e0767b` or its Supabase database.** Do not run Lovable agent messages. Do not use production service-role credentials. Do not create a production connection.
2. Build and test only using fixture data and an isolated **local** Postgres instance or isolated, explicitly named development database. Default configuration must fail closed for external publishing.
3. No unauthorized scraping. Per-source allowlist required. Follow applicable terms, robots directives where relevant, rate limits and access restrictions. Do not evade login, paywalls, anti-bot controls or CAPTCHAs; do not assume Reddit or YouTube content is commercially reusable merely because it is public.
4. No storing/reposting copyrighted article, comment or transcript bodies by default. Store minimally necessary derived observation metadata and link back; apply source-specific retention/deletion policies. No embeddings of restricted text without rights.
5. External AI inference must **never** be transformed into a numeric 1–5 player rating unless the original source explicitly provides that rating on a understood scale and the mapping is verified. A positive sentiment is not a 5-star rating. Do not fabricate handicap, ownership, play testing, recommendation or value judgments.
6. Only distinct, attributable first-hand experiences that pass provenance and independence checks are eligible to be considered player evidence. Review/article summaries, product announcements, sponsorships, retailer listings and repeated syndicated posts are not independent player ratings.
7. Stage candidates pending review. No automatic insertion into `public.player_signals`, no automatic adjustment of TPR's `product_scores` or `product_points`.
8. Keep affiliate/commerce data out of evidence scoring and ranking. Preserve Good/Better/Best as **price tiers**; do not invent a Value Score; call Good/Bad/Overall Sentiment "Player Consensus" and the product report "The Caddie Brief".
9. Implement audit logs, deterministic idempotency, retries with dead-letter handling, source revocation and deletion/tombstones, tests, and runbooks. Never log secrets or raw PII.
10. Ask for human approval before enabling any live connector or publication pathway. This repository should be independently usable with fixtures, with outbound network disabled in tests.

## Suggested implementation stack

TypeScript on Node.js LTS, pnpm, PostgreSQL + Drizzle migrations, Zod, Vitest, an isolated worker/queue (e.g. pg-boss or BullMQ + Redis if needed), structured logs and OpenTelemetry-compatible tracing. Prefer simple Postgres job queues initially if operationally sufficient. The Lovable frontend remains TanStack Start/React and is OUT OF SCOPE.

## Development sequence

Implement Phase 0 (contracts, dev environment, tests) then Phase 1 (fixture-first ingestion and extraction). Next implement compliance-aware connectors only after each source's policy is reviewed. See `tasks/IMPLEMENTATION-BACKLOG.md`.

## End-of-task report

For each task provide: files changed, commands/tests run, passing/failing results, open risks, and an explicit statement that no Lovable project/database changes were made.
