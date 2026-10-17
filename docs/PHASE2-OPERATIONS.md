# Phase 2 — permitted-source collection foundation

This implementation runs **mock HTTP only**. No real source was activated or contacted. No Lovable/Supabase integration, scoring change, external inference call, deployment or publication is present. A source's mock policy approval authorizes only synthetic test responses, not legal use of a real publication/API.

## Reproduce and validate

From the repository root, with Node 24, pnpm 11.25.0 and Docker Compose:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate
pnpm seed
pnpm demo
pnpm demo:phase2
pnpm lint
pnpm typecheck
pnpm build
pnpm db:test:create
DATABASE_URL=postgresql://tpr_dev:tpr_dev_fixture_only@127.0.0.1:55432/tpr_ingestion_test pnpm test:all
pnpm smoke
```

In the cloud sandbox, append `--store-dir /workspace/.pnpm-store` to the install command. The tests use the disposable local test DB. The Phase 2 demo preserves existing data and decisions, registers **four synthetic sources**, explicitly approves mock-only policies, enables mock collection, ingests and repeats each source, approves one eligible mock forum observation, and explicitly authorizes a local analysis export. Existing approved Phase 0/1 records can appear in that export; counts are not limited to the mock demo's new observation.

The first Phase 2 demo yields **five observations** (two YouTube discovery references, one editorial RSS item, two forum records) plus **one separate manufacturer fact**. Repeats create no new observations and RSS uses ETag/Last-Modified. Titles/video metadata never create first-hand experiences, sentiment or ratings. The forum's ambiguous G440 mention remains pending manual product identification. All reported content and specifications are synthetic.

Demos honor persistent suspension, expiry, quotas and review state. They do not reset operator decisions or silently grant replacement permissions. For example, the YouTube mock policy budgets 1,000 units per UTC day and each search page conservatively costs 100 units; repeated demos can exhaust it. Inspect job results or use the test suite for isolated clean-state runs. Real API cost/terms must be verified before any later activation.

## Source lifecycle

1. Register a source using the dashboard or `pnpm cli source-add --file source.json --reviewer local-admin`. Registration starts disabled with a pending policy.
2. Supply an explicit mock policy using `pnpm cli source-policy --source SOURCE_ID --file policy.json --reviewer local-admin`. Policies require a permission citation, expiry within 366 days, operation flags and metadata-retention days. Each approval creates a new immutable policy version and leaves collection disabled.
3. Explicitly authorize synthetic requests using `pnpm cli source-enable-mock --source SOURCE_ID --reviewer local-admin`.
4. Run `pnpm cli collect-mock --source SOURCE_ID --key unique-collection-key --reviewer local-admin`. This uses the built-in synthetic HTTP profile matching the connector type, **not the configured remote host**. Collection frequency applies unless the operator explicitly supplies `--force`; policy/quota/rate gates still apply even with force.
5. Inspect `pnpm cli sources`, `pnpm cli jobs`, source event history and the reviewer queue.
6. Suspend with `pnpm cli source-suspend --source SOURCE_ID --reviewer local-admin`. Suspension stops requests, revokes staged/approved observations and facts, and marks affected export batches for retraction. Policy reapproval plus mock enable can stage new observations under a new policy version. Permanently tombstoned sources/items cannot simply be re-enabled.

`pnpm cli source-update --file source.json --reviewer local-admin` requires the source already be disabled, resets its checkpoint/validators, and creates a pending policy. An expired policy must be reapproved; restarting or reseeding cannot renew it. `NETWORK_ENABLED`, `CONNECTOR_ENABLED` and `PRODUCTION_EXPORT_ENABLED` stay false. The schema also constrains `live_authorized=false`; the API accepts only `scope: "mock"` approvals. There is no live activation command.

Example source configuration (all fields are non-secret):

```json
{
  "source_id": "operator-rss",
  "name": "Synthetic permitted publication",
  "type": "rss",
  "url": "https://mock-golf.example.org/rss",
  "interval_seconds": 3600,
  "daily_budget": 100,
  "min_request_interval_ms": 1000,
  "settings": {
    "allowed_hosts": ["mock-golf.example.org"],
    "format": "rss",
    "max_pages": 2
  }
}
```

Use the dashboard's generated mock policy JSON for a current expiry. Its operations separately control discovery, metadata, body analysis, derived insights, manufacturer facts and analysis export. Raw text retention is always zero. External rating export is denied in Phase 2 mock policies; existing fixture explicit-rating exports retain their Phase 1 gates. Source types are `youtube`, `rss`, `manufacturer`, `forum`, `api` and reserved `approved-html`; generic HTML parsing is deliberately unsupported until a source-specific parser/robots/permission review.

## Connectors and data contracts

| Adapter                      | Behavior                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| YouTube Data API             | Official `search` endpoint, configurable channels/keywords/product queries, page tokens, per-search quota units, incremental publication watermark. Only metadata/references; no transcripts/comments or title-derived player opinions. A future secret binding can use only `TPR_YOUTUBE_API_KEY` via a header, never a query-string credential. No credential is needed for mocks. |
| RSS/Atom                     | Singleton/multiple entries, canonical references, optional dates, ETag/Last-Modified and 304 handling. Bodies remain transient and are omitted unless body analysis is explicitly permitted. XML DTD/entities and malformed feeds are rejected.                                                                                                                                      |
| Manufacturer                 | Structured JSON feeds/APIs carry explicit specifications, model, variant and release date. RSS/Atom can contribute clearly labeled publication metadata only, not fabricated specs. Facts have their own table/revision/review workflow and never become player observations.                                                                                                        |
| Approved forum / generic API | Strict JSON envelope, attributable individual post URLs, bounded pagination, policy-controlled body analysis, no author-profile storage or scraping. No site-specific forum HTML, Reddit scraper, login bypass or CAPTCHA evasion.                                                                                                                                                   |

The reusable JSON envelope is `{ "items": ExternalRecord[], "next": "https://approved-host/next-page" | null }`. `ExternalRecord` is enforced in `packages/contracts/sources.ts`: required ID, HTTPS URL, nullable publication date, title and content class; optional transient body/product mention, directly supplied structured context/rating fields, or manufacturer specs. Unknown fields are rejected. An individually approved source needs an adapter to its documented official/licensed envelope; arbitrary forum websites do not automatically implement this protocol.

## Reliability and HTTP security

- Collection requests reserve daily units and request spacing atomically in PostgreSQL. Leases serialize work per source; stale workers cannot commit after another claim takes ownership.
- Each accepted page and its checkpoint commit together. Later quota/rate/HTTP failure keeps already-staged pages and resumes from the durable cursor. YouTube's publication watermark advances only after all configured searches finish.
- Sources have configured schedules, health status, successful collection times, immutable policy/error event history and request-accounting rows. Jobs retry with bounded exponential backoff, honor bounded Retry-After hints, and reach a dead-letter state after three failures. Quota/spacing deferrals do not spend a failure attempt. 401/403 shut down collection.
- HTTPS destinations require exact source host allowlists. Userinfo, unexpected ports, literal/private/reserved addresses and local hostnames are denied. Every DNS answer must be public; the live HTTP implementation pins the validated address to the TLS request and retains hostname/SNI certificate checks.
- Redirects are rejected, not followed. DNS/request timeouts, a 1 MB response cap, no compressed responses, bounded record counts/pages and hostile XML checks apply. Mock responses exercise the same collector response/policy gates. Tests fake the low-level HTTPS implementation to check pinning, TLS defaults, timeout, size and redirect behavior without a real socket.
- Request/error logs retain reason codes, counts and IDs rather than tokens, query strings, bodies or raw PII. Nothing installs a VPN, bypasses TLS verification or weakens checksum validation.

The source kill switch and policy are checked before every request and after a response before staging. Separate release approval, deployment auth, an approved egress policy and individually reviewed source permissions are still prerequisites for real collection. No such approval is implied by passing mock tests.

## Product matching, extraction and moderation

The existing exact fixture matcher remains stable. The new resolver supports curated brand/model aliases, product family/generation/variant metadata, category/type and configuration qualifiers. Conflicting variants, unknown generations/configurations and bare G440 family references abstain. Categories cover clubs, balls/bags and golf technology. Catalog edits are admin-only and never update the live TPR catalog automatically.

`ExtractionProvider` accepts transient permitted body text and proposes a strict structure: positive/negative controlled topics, supporting offsets, first-/second-hand classification and confidence. The default is explainable rules; no hosted model is connected. Out-of-bounds spans and invented result fields are rejected. Retained evidence consists of topic/polarity and support hashes, provider version/confidence and linked provenance, not quotes or article bodies. Only directly supplied structured source fields can populate ratings/player context/recommendation/value fields; a provider cannot emit them. Unknown stays null. Human review remains required and this rule set is not a calibrated accuracy guarantee.

The dashboard offers source health/permissions, jobs/failures/retries, pending/approved/rejected evidence, canonical-product corrections, manufacturer-fact review, eligible export previews and export/retraction history. Product corrections are allowed only while staged and create idempotent immutable review events. Editorial analysis can be approved separately from first-hand player evidence; metadata-only discovery remains held and never qualifies as a rating. Exports recheck policy version, current rights, quality, review state and tombstones. Preview and actual generation share one eligibility selector.

## Retention and deletion

`pnpm cli purge --reviewer local-admin` processes up to 500 expired source items using their policy's metadata-retention period. Repeat while `more_may_remain` is true. It revokes evidence/facts, marks export retractions, removes retained metadata/context/attributes, and leaves minimal hashed identity/URL tombstones plus audit history to prevent replay. No source bodies are stored in PostgreSQL. The earliest collection timestamp, rather than refreshed last-seen time, controls expiry.

Individual takedowns and permanent source revocation retain tombstones; ordinary source suspension is a distinct control that can be reconsidered through policy reapproval. Existing artifacts are historical local files: withdraw old copies and deliver the retraction list to downstream users. The service does not delete copies in external systems or mutate Lovable. Metadata purge is an explicit admin task; deployment scheduling and downstream retraction acknowledgements remain operational work.

## API additions

All use the existing token/Basic auth, role checks, no-store/CSP headers, custom mutation header and origin checks. Tokens remain local; no secrets appear in configuration JSON.

| Endpoint                                             | Access                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `POST /sources`, `PUT /sources/:id`                  | Admin register/reconfigure disabled source                      |
| `GET /sources`, `GET /sources/:id`                   | Authenticated health/configuration                              |
| `POST /sources/:id/policy`                           | Admin mock policy version approval                              |
| `POST /sources/:id/enable-mock`                      | Admin explicit mock authorization                               |
| `POST /sources/:id/collect-mock`                     | Admin synthetic profile run; idempotency key and optional force |
| `POST /sources/:id/disable`                          | Admin suspension/suppression                                    |
| `POST /collections/due-mock`                         | Admin scheduler tick for due synthetic profiles                 |
| `GET /sources/:id/events`, `GET /jobs?source_id=...` | Authenticated history, job pagination                           |
| `GET /products`, `POST /products`                    | Authenticated read / admin curated insert                       |
| `POST /observations/:id/product-match`               | Reviewer/admin staged correction with reason/idempotency key    |
| `GET /observations/:id/evidence`                     | Authenticated derived attributes/provenance                     |
| `GET /facts`, `POST /facts/:id/decision`             | Authenticated paginated facts / reviewer decisions              |
| `POST /exports/preview`, `GET /exports/history`      | Authenticated eligibility/audit                                 |
| `POST /retention/purge`                              | Admin purge expired metadata                                    |

## Scope still requiring separate work

This is a tested collection **foundation**, not a production deployment certification. Live rights/credentials/egress activation, any actual website/forum mapping, per-person SSO/TLS, representative licensed accuracy evaluation, distributed monitoring/alerting and operational purge scheduling remain unverified. Redirect following is intentionally unsupported. A future hosted extraction provider needs its own permission/privacy review. No external commentary enters TPR Consensus Scores, and no source approval substitutes for review/publication authorization.
