import { MockTransport, CollectionError, type HttpResponse } from './http.js';
import {
  sourceDefinition,
  policyApproval,
  type RegistrySource,
} from '../contracts/sources.js';
const now = '2026-10-01T12:00:00Z';
export const mockDefinitions = ['youtube', 'rss', 'manufacturer', 'forum'].map(
  (type) =>
    sourceDefinition.parse({
      source_id: `demo-${type}`,
      name: `Synthetic ${type} source`,
      type,
      url:
        type === 'youtube'
          ? 'https://www.googleapis.com/youtube/v3/search'
          : `https://mock-golf.example.org/${type}`,
      min_request_interval_ms: 0,
      daily_budget: 1000,
      settings: {
        allowed_hosts:
          type === 'youtube'
            ? ['www.googleapis.com', 'www.youtube.com']
            : ['mock-golf.example.org'],
        format: type === 'rss' ? 'rss' : 'json',
        channels: type === 'youtube' ? ['synthetic_channel'] : [],
        keywords: type === 'youtube' ? ['Ping G440 Max'] : [],
        max_pages: 2,
      },
    }),
);
export const mockPolicy = () =>
  policyApproval.parse({
    permission_reference:
      'Synthetic mock responses only; no live-source access grant',
    scope: 'mock',
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    metadata_days: 30,
    operations: {
      discovery: true,
      metadata: true,
      derived_insights: true,
      analyze_body: true,
      manufacturer_facts: true,
      export_analysis: true,
      export_ratings: false,
    },
  });
export function mockTransportFor(type: RegistrySource['type']) {
  return new MockTransport((input): HttpResponse => {
    const u = new URL(input.url);
    const second =
      u.searchParams.has('pageToken') || u.searchParams.has('page');
    if (type === 'youtube')
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          ...(second ? {} : { nextPageToken: 'second' }),
          items: [
            {
              id: { videoId: second ? 'mock_video_2' : 'mock_video_1' },
              snippet: {
                title: 'Ping G440 Max Driver — synthetic video discovery',
                publishedAt: now,
              },
            },
          ],
        }),
      };
    if (type === 'rss')
      return input.headers?.['if-none-match'] === '"synthetic-v1"'
        ? { status: 304, headers: {}, body: '' }
        : {
            status: 200,
            headers: {
              etag: '"synthetic-v1"',
              'last-modified': 'Thu, 01 Oct 2026 12:00:00 GMT',
            },
            body: `<rss version="2.0"><channel><title>Synthetic licensed metadata</title><item><guid>synthetic-article-1</guid><link>https://mock-golf.example.org/review/1</link><title>Ping G440 Max Driver review</title><pubDate>${now}</pubDate><description>Good forgiveness and harsh sound in this synthetic editorial.</description></item></channel></rss>`,
          };
    if (type === 'manufacturer')
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [
            {
              external_id: 'synthetic-spec-1',
              url: 'https://mock-golf.example.org/product/g440-max',
              published_at: now,
              title: 'Ping G440 Max Driver',
              product_label: 'Ping G440 Max Driver',
              kind: 'manufacturer',
              model: 'G440-MAX',
              variant: 'Max',
              release_date: '2026-01-01',
              facts: {
                loft_degrees: 10.5,
                material: 'synthetic titanium fixture',
                adjustable: true,
              },
            },
          ],
        }),
      };
    if (type === 'forum' || type === 'api')
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: [
            {
              external_id: second ? 'synthetic-post-2' : 'synthetic-post-1',
              url: `https://mock-golf.example.org/thread/${second ? 2 : 1}`,
              published_at: now,
              title: second ? 'Ping G440' : 'Ping G440 Max Driver',
              product_label: second ? 'Ping G440' : 'Ping G440 Max Driver',
              kind: 'player',
              body: 'I used this club. Good forgiveness but harsh sound.',
              structured: { sponsored: false },
            },
          ],
          ...(second
            ? {}
            : { next: 'https://mock-golf.example.org/forum?page=2' }),
        }),
      };
    throw new CollectionError('mock_profile_unavailable');
  });
}
