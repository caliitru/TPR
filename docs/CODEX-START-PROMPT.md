# Copy/paste prompt for Codex

Build a new, independent, production-minded but **fixture-only initially** ingestion service for The Players' Room from the attached specification. Read `AGENTS.md`, `docs/TPR-TECHNICAL-AUDIT-AND-INGESTION-ARCHITECTURE.md`, `tasks/IMPLEMENTATION-BACKLOG.md` and `contracts/*.json` before editing.

Start with **Phase 0 only**, working in this NEW repository. Implement the repository structure, local Postgres migrations, typed contracts, CI checks, environment/network kill switches, and synthetic test fixtures. Do not attempt live scraping or use external APIs. When Phase 0 is complete, run lint/typecheck/tests, provide a detailed summary and STOP for review before Phase 1.

STRICT PROHIBITION: Do not modify, deploy, message the agent for, or write to the Lovable project `c7736b82-13bd-4687-a645-a86e46e0767b`; do not connect to its Supabase database; do not use production credentials. This separate repository is the sole write target.

Architectural constraints: separate observations from ratings, no AI-derived numeric votes, policy allowlist disabled by default, dedupe and audit, reviewer-approved export, source rights and deletion workflows, no affiliate influence. Prefer a simple stack with explainable components and migration/test coverage. Explain every design departure from the handoff before implementing it.
