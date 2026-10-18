# Live source assessment results

Historical initial assessment. See the [commercial permissions retry](COMMERCIAL-RETRY-2026-10-17.md) for the continuation after network access changed. The original evidence below is preserved.

Baseline: PR #4 `663778d`, verified with both GitHub CI checks successful. Branch `feat/live-source-assessment` extends the existing source registry; no ingestion architecture was replaced.

## Real external acquisition — blocked, not a successful collection

| Measure                                                                | Actual result                   |
| ---------------------------------------------------------------------- | ------------------------------- |
| Catalog candidates assessed for blockers                               | 43                              |
| Unique policy/navigation requests attempted in the recorded assessment | 36                              |
| Requests denied by environment CONNECT proxy                           | 36                              |
| Origin documents retrieved / current terms verified                    | 0 / 0                           |
| Data-collection sources contacted / eligible data endpoints            | 0 / 0                           |
| Genuine external records / real product mentions                       | 0 / 0                           |
| Valid firsthand observations / manufacturer facts                      | 0 / 0                           |
| Real duplicates / rejected records / moderation queue                  | 0 / 0 / 0                       |
| Eligible observation source URLs                                       | None — no eligible observations |
| Live scheduler deployed / production publication                       | No / no                         |

Initial diagnostic HEAD requests to PING's candidate legal URL, Google's official developer policies and Golf Monthly's candidate terms URL also failed at the proxy. Those were troubleshooting requests, not product/feedback collection. The complete recorded assessment then attempted 36 distinct navigation/policy URLs, sharing Reddit policies across its nine communities. The environment's custom egress list initially contained only `api.github.com` plus package-manager presets. These CONNECT 403 responses do not establish that publishers prohibit access or commercial use.

[Real assessment JSON](real-assessment.json) contains immutable run ID, per-source canonical catalog URLs, exact attempted URLs, attempt timestamps, null origin statuses, proxy denial codes, unknown operations/retention, credential presence booleans and missing prerequisites. No response body, API key or proxy credential is committed. [Authorization matrix](AUTHORIZATION-MATRIX.md) covers all 43 candidates with separate commercial gates and technical blockers. **No current official terms have been read or verified through the blocked network.** This limitation prevents legal clearance and a permitted data pilot.

## Products

The independent development database contains only six products, all marked `synthetic-v1`:

- Ping G440 Max Driver
- Ping G440 SFT Driver
- Ping G440 LST Driver
- Ping G430 Max Driver
- TaylorMade Qi35 Driver
- Titleist GT2 Driver

These existing identities were selected provisionally, with variants preserved. They are not presented as newly acquired or independently verified facts. No products, irons or golf devices were invented to reach 10–15. Verified manufacturer identities and release dates are missing. Five-year collection cannot be safely executed until release dates and the licensed historical endpoint are verified; no pre-release history is requested or manufactured.

## Implementation and reproducible commands

- New `source_assessment_runs` migration/model stores immutable assessment snapshots. Existing source events record each assessment without changing policies or operational enablement.
- New strict assessment schema distinguishes unknown rights, proxy denial, origin denial, redirects, reviewable document retrieval and actual verification. HTTP success never auto-approves a source.
- The bounded policy-research adapter uses the platform HTTPS proxy through curl, HTTPS-only URLs, the explicit catalog/legal host list, existing public-URL validation, 20-second request deadlines, 512 KiB limits and no redirects. It discards bodies and stderr; only document hashes and allowed policy-navigation links can be retained. It does not call data APIs or enable collection.
- `source-assess` reads the actual registered source configurations for all 43 candidate IDs, records operation-specific prerequisites and produces separate real/mock sections. `source-assessments` inspects the last ten snapshots. Existing live collector, database-isolation and publication gates remain in force.

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm seed
pnpm cli registry-seed --reviewer local-admin
# Explicit genuine policy navigation; NOT source data collection or activation:
pnpm cli source-assess --authorize-policy-research --reviewer local-source-assessor
pnpm cli source-assessments
pnpm lint
pnpm typecheck
pnpm build
pnpm db:test:create
DATABASE_URL=postgresql://tpr_dev:tpr_dev_fixture_only@127.0.0.1:55432/tpr_ingestion_test pnpm test:all
pnpm smoke
```

Policy assessment is not part of CI or startup. It requires curl in the environment (available in this cloud instance). Tests inject all research responses and never call curl or external source hosts.

## Mock/testing — separate from acquisition

No new synthetic product or player records were generated for the real assessment. Unit/integration tests simulate proxy denials, origin failures, redirects and successful policy-page retrieval without treating any of them as real source content or authorization. They test all 43 entries, actual-registry reads, URL dedupe, admin checks, unchanged disabled/pending states, immutable audit snapshots and zero data acquisition. **257 tests passed across nine files** (246 prior + 11 assessment checks). Frozen dependency installation, lint, TypeScript checking, build and the compiled API smoke passed. The CLI was also verified to refuse policy navigation without its explicit authorization flag. The existing fixture pipeline exercises 123 synthetic source items and 120 synthetic observations per standard run; repeated test executions are not real acquisition totals. Earlier fixture/demo totals are not included in the real totals above.

## Required unblock and remaining work

A network draft was saved adding the catalog's exact source hosts, common official www aliases and official Google/Reddit/publisher policy hosts while preserving existing domains/presets. The user must review/save those environment settings and publish the environment; draft saving does not apply egress policy. No network proxy bypass, unrelated mirror or direct private connection was attempted.

After network access actually works, read the official documents, verify operation-specific rights and retention, resolve redirects/official feed/API locations and obtain any required written licenses/secure credentials. The current snapshot must remain **unverified** until that work is completed. If an eligible source is then established, implement a narrowly scoped expiring manual pilot grant using the existing collectors, independently verify product identities/release dates, execute bounded genuine acquisition and audit a real rerun. Existing mock-only/live-disabled safeguards were intentionally not weakened in the absence of any verified eligible source.

No source has been activated, no scheduler deployed, no Consensus Score logic modified, and no Lovable project or Supabase database accessed. The requested first permitted live collection remains blocked by current-term verification/network access and missing source prerequisites; a mock result is not substituted for success.
