import { expect, it } from 'vitest';
import {
  parsePolicyEvidence,
  researchPolicy,
} from '../packages/core/policy-research.js';
import {
  assessmentFromEvidence,
  policyTargets,
} from '../packages/core/source-assessment.js';
import { sourceCatalog } from '../packages/db/source-catalog.js';
const now = new Date('2026-10-18T01:00:00Z');
it('distinguishes environment CONNECT denial from source terms or origin denial', () => {
  const e = parsePolicyEvidence(
    'https://ping.com/',
    ['ping.com'],
    '\nTPR_POLICY_META:000:403',
    56,
    now,
  );
  expect(e.outcome).toBe('proxy_connect_denied');
  expect(e.origin_status).toBeNull();
  expect(e.content_sha256).toBeNull();
  expect(e.proxy_connect_status).toBe(403);
});
it('HTTP success never grants collection rights or retains source bodies', () => {
  const text =
    '<p>Restricted text must not be retained</p><a href="/legal">Legal</a><a href="https://evil.example/terms">Other</a>';
  const evidence = parsePolicyEvidence(
    'https://ping.com/',
    ['ping.com'],
    text + '\nTPR_POLICY_META:200:200',
    0,
    now,
  );
  expect(evidence.discovered_policy_links).toEqual(['https://ping.com/legal']);
  expect(evidence.content_sha256).toHaveLength(64);
  expect(JSON.stringify(evidence)).not.toContain('Restricted text');
  const row = assessmentFromEvidence(
    sourceCatalog.find((s) => s.name === 'PING')!,
    [evidence],
    null,
    now,
  );
  expect(row.eligible_for_pilot).toBe(false);
  expect(row.terms_verified_at).toBeNull();
  expect(row.operations.collection).toBe('unknown');
  expect(row.classification).toBe('additional_terms_verification_required');
});
it.each([
  [403, 'origin_denied'],
  [429, 'origin_denied'],
  [302, 'redirect_requires_review'],
  [404, 'network_error'],
])(
  'records HTTP %s without bypass or automatic policy approval',
  (code, outcome) => {
    expect(
      parsePolicyEvidence(
        'https://ping.com/',
        ['ping.com'],
        `\nTPR_POLICY_META:${code}:200`,
        0,
        now,
      ).outcome,
    ).toBe(outcome);
  },
);
it('keeps Reddit gated by the registry requirement and identifies the unavailable TPR placeholder', () => {
  for (const def of sourceCatalog.filter(
    (s) => s.registry!.category === 'reddit',
  )) {
    const row = assessmentFromEvidence(def, [], false, now);
    expect(row.classification).toBe('commercial_agreement_required');
    expect(row.commercial_rights).toBe('unverified');
  }
  expect(policyTargets('tpr', 'https://theplayersroom.example/')).toEqual([]);
  expect(
    policyTargets('manufacturer', 'https://ping.com/private-data?key=not-used'),
  ).toEqual(['https://ping.com/']);
  expect(
    assessmentFromEvidence(
      sourceCatalog.find((s) => s.registry!.category === 'tpr')!,
      [],
      null,
      now,
    ).classification,
  ).toBe('unavailable_unsupported');
});
it('refuses private, non-HTTPS and unlisted research destinations before invoking transport', async () => {
  for (const url of [
    'http://ping.com/',
    'https://127.0.0.1/',
    'https://example.org/',
  ])
    await expect(researchPolicy(url, ['ping.com'])).rejects.toThrow();
});
