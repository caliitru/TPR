import { expect, it } from 'vitest';
import { weeklySlot, fiveYearStart } from '../packages/core/weekly.js';
import {
  normalizedContentUrl,
  contentIdentity,
} from '../packages/core/content-identity.js';
import { externalRecord } from '../packages/contracts/sources.js';
it.each([
  ['2026-10-18T05:59:59Z', '2026-10-11T06:00:00.000Z'],
  ['2026-10-18T06:00:00Z', '2026-10-18T06:00:00.000Z'],
  ['2026-03-08T06:59:59Z', '2026-03-01T07:00:00.000Z'],
  ['2026-03-08T07:00:00Z', '2026-03-08T07:00:00.000Z'],
  ['2026-11-01T06:59:59Z', '2026-10-25T06:00:00.000Z'],
  ['2026-11-01T07:00:00Z', '2026-11-01T07:00:00.000Z'],
])('resolves weekly New York slot at %s', (now, expected) =>
  expect(weeklySlot(new Date(now)).toISOString()).toBe(expected),
);
it('clamps the separate five-year window across leap days', () =>
  expect(fiveYearStart(new Date('2024-02-29T12:00:00Z')).toISOString()).toBe(
    '2019-02-28T12:00:00.000Z',
  ));
it('normalizes URLs and conservatively fingerprints syndicated evidence independently of publisher IDs', () => {
  expect(
    normalizedContentUrl(
      'https://EXAMPLE.org/thread/?b=2&utm_source=x&a=1#reply',
    ),
  ).toBe('https://example.org/thread?a=1&b=2');
  const a = externalRecord.parse({
    external_id: 'a',
    url: 'https://example.org/a',
    published_at: null,
    title: 'Ping G440 Max',
    body: 'I used this club. Good forgiveness.',
    product_label: 'Ping G440 Max',
    kind: 'player',
  });
  const b = {
    ...a,
    external_id: 'b',
    url: 'https://example.org/b',
    body: 'I used this club.   Good forgiveness.',
  };
  expect(contentIdentity(a, 'one').observation).toBe(
    contentIdentity(b, 'two').observation,
  );
  expect(
    contentIdentity(
      {
        ...a,
        structured: {
          explicit_rating: {
            value: 4,
            scale_min: 1,
            scale_max: 5,
            evidence_basis: 'structured_source_field',
          },
        },
      },
      'one',
    ).revision,
  ).not.toBe(contentIdentity(a, 'one').revision);
});
