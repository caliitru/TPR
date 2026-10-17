import { z } from 'zod';
import { stableId } from '../core/identity.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  externalRecord,
  type ExternalRecord,
  type RegistrySource,
} from '../contracts/sources.js';
import {
  allowedUrl,
  CollectionError,
  type HttpRequest,
  type HttpResponse,
} from './http.js';
export interface DiscoveryBatch {
  records: ExternalRecord[];
  state: Record<string, unknown>;
  etag?: string;
  lastModified?: string;
  unchanged?: boolean;
}
export type PageSink = (batch: DiscoveryBatch) => Promise<void>;
export type Request = (input: HttpRequest) => Promise<HttpResponse>;
const array = (v: unknown): unknown[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];
const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number'
      ? String(v)
      : v && typeof v === 'object' && '#text' in v
        ? text(v['#text'])
        : '';
function date(v: unknown): string | null {
  const d = new Date(text(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function safeXml(body: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true)
    throw new CollectionError('invalid_feed');
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
    parseTagValue: false,
    trimValues: true,
  }).parse(body) as Record<string, unknown>;
}
const entry = z
  .object({
    id: z.string().optional(),
    guid: z.unknown().optional(),
    title: z.unknown().optional(),
    link: z.unknown().optional(),
    pubDate: z.unknown().optional(),
    published: z.unknown().optional(),
    updated: z.unknown().optional(),
    description: z.unknown().optional(),
    summary: z.unknown().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();
export async function feedConnector(
  source: RegistrySource,
  request: Request,
): Promise<DiscoveryBatch> {
  const headers: Record<string, string> = {};
  if (source.etag) headers['if-none-match'] = source.etag;
  if (source.last_modified) headers['if-modified-since'] = source.last_modified;
  const res = await request({ url: source.url, headers });
  if (res.status === 304)
    return { records: [], state: source.discovery_state, unchanged: true };
  const parsed = safeXml(res.body);
  const atom = parsed.feed;
  const channel = z
    .object({ channel: z.object({ item: z.unknown().optional() }) })
    .safeParse(parsed.rss);
  const items = atom
    ? array(z.object({ entry: z.unknown().optional() }).parse(atom).entry)
    : channel.success
      ? array(channel.data.channel.item)
      : [];
  if (!atom && !channel.success) throw new CollectionError('invalid_feed');
  if (items.length > 1000) throw new CollectionError('too_many_records');
  const records = items.map((raw) => {
    const e = entry.parse(raw);
    let link = text(e.link);
    if (atom) {
      const links = array(e.link) as Record<string, unknown>[];
      const match = links.find(
        (l) => !l['@_rel'] || l['@_rel'] === 'alternate',
      );
      link = text(match?.['@_href']);
    }
    const url = allowedUrl(link, source.settings.allowed_hosts, true).href;
    const body = source.allowed_operations.analyze_body
      ? text(e.description ?? e.summary ?? e.content)
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .slice(0, 20000)
      : '';
    return externalRecord.parse({
      external_id: stableId(text(e.id ?? e.guid) || url),
      url,
      published_at: date(e.published ?? e.pubDate ?? e.updated),
      title: text(e.title).slice(0, 300),
      body,
      product_label: '',
      kind: 'editorial',
    });
  });
  return {
    records,
    state: {},
    etag: res.headers.etag,
    lastModified: res.headers['last-modified'],
  };
}
const videoPage = z.object({
  nextPageToken: z.string().max(500).optional(),
  items: z
    .array(
      z.object({
        id: z.object({ videoId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }),
        snippet: z.object({
          title: z.string().max(300),
          publishedAt: z.iso.datetime({ offset: true }),
        }),
      }),
    )
    .max(50),
});
export async function youtubeConnector(
  source: RegistrySource,
  request: Request,
  secret: (name: string) => string | undefined = () => undefined,
  onPage?: PageSink,
): Promise<DiscoveryBatch> {
  if (
    new URL(source.url).origin !== 'https://www.googleapis.com' ||
    new URL(source.url).pathname !== '/youtube/v3/search'
  )
    throw new CollectionError('youtube_endpoint_denied');
  const queries = [...source.settings.keywords, ...source.settings.products];
  if (!queries.length) queries.push('golf equipment');
  const channels = source.settings.channels.length
    ? source.settings.channels
    : [''];
  const searches = queries.flatMap((q) =>
    channels.map((channel) => ({ q, channel })),
  );
  const state = z
    .object({
      search: z.number().int().min(0).default(0),
      page: z.string().optional(),
      watermark: z.string().optional(),
      cycle_watermark: z.string().optional(),
    })
    .parse(source.discovery_state);
  let search = state.search;
  if (search >= searches.length) search = 0;
  let page = state.page;
  let watermark = state.cycle_watermark ?? state.watermark;
  const records: ExternalRecord[] = [];
  for (
    let count = 0;
    count < source.settings.max_pages && search < searches.length;
    count++
  ) {
    const query = searches[search]!;
    const url = new URL(source.url);
    url.search = '';
    for (const [k, v] of Object.entries({
      part: 'snippet',
      type: 'video',
      order: 'date',
      maxResults: '50',
      q: query.q,
      ...(query.channel ? { channelId: query.channel } : {}),
      ...(page ? { pageToken: page } : {}),
      ...(state.watermark ? { publishedAfter: state.watermark } : {}),
    }))
      url.searchParams.set(k, v);
    const key = source.settings.api_key_env
      ? secret(source.settings.api_key_env)
      : undefined;
    const res = await request({
      url: url.href,
      quotaUnits: 100,
      headers: key ? { 'x-goog-api-key': key } : {},
    });
    const data = videoPage.parse(JSON.parse(res.body));
    for (const v of data.items) {
      records.push(
        externalRecord.parse({
          external_id: v.id.videoId,
          url: `https://www.youtube.com/watch?v=${v.id.videoId}`,
          published_at: new Date(v.snippet.publishedAt).toISOString(),
          title: v.snippet.title,
          kind: 'discovery',
        }),
      );
      if (
        !watermark ||
        new Date(v.snippet.publishedAt).getTime() >
          new Date(watermark).getTime()
      )
        watermark = new Date(v.snippet.publishedAt).toISOString();
    }
    page = data.nextPageToken;
    if (!page) search++;
    await onPage?.({
      records: records.slice(-data.items.length || records.length),
      state:
        search >= searches.length
          ? { search: 0, watermark }
          : {
              search,
              page,
              watermark: state.watermark,
              cycle_watermark: watermark,
            },
    });
  }
  // Advance watermark only after every configured channel/query has exhausted pagination.
  return {
    records,
    state:
      search >= searches.length
        ? { search: 0, watermark }
        : {
            search,
            page,
            watermark: state.watermark,
            cycle_watermark: watermark,
          },
  };
}
const jsonPage = z.object({
  items: z.array(externalRecord).max(1000),
  next: z.url().startsWith('https://').nullable().optional(),
});
export async function jsonConnector(
  source: RegistrySource,
  request: Request,
  onPage?: PageSink,
): Promise<DiscoveryBatch> {
  let next =
    typeof source.discovery_state.next === 'string'
      ? source.discovery_state.next
      : source.url;
  const records: ExternalRecord[] = [];
  for (let i = 0; i < source.settings.max_pages; i++) {
    allowedUrl(next, source.settings.allowed_hosts);
    const res = await request({ url: next });
    const parsed = jsonPage.parse(JSON.parse(res.body));
    for (const raw of parsed.items) {
      allowedUrl(raw.url, source.settings.allowed_hosts, true);
      if (source.type === 'manufacturer') {
        if (
          raw.kind !== 'manufacturer' ||
          !raw.facts ||
          Object.keys(raw.facts).length > 100
        )
          throw new CollectionError('invalid_manufacturer_facts');
        records.push({ ...raw, body: '', structured: {} });
      } else {
        if (raw.kind === 'manufacturer')
          throw new CollectionError('wrong_content_lane');
        records.push({
          ...raw,
          body: source.allowed_operations.analyze_body ? raw.body : '',
          kind: source.allowed_operations.analyze_body ? raw.kind : 'discovery',
        });
      }
    }
    const state = parsed.next
      ? { next: allowedUrl(parsed.next, source.settings.allowed_hosts).href }
      : {};
    await onPage?.({
      records: records.slice(-parsed.items.length || records.length),
      state,
    });
    if (!parsed.next) return { records, state: {} };
    next = allowedUrl(parsed.next, source.settings.allowed_hosts).href;
  }
  return { records, state: { next } };
}
export async function discoverExternal(
  source: RegistrySource,
  request: Request,
  secret?: (name: string) => string | undefined,
  onPage?: PageSink,
): Promise<DiscoveryBatch> {
  if (source.type === 'youtube')
    return youtubeConnector(source, request, secret, onPage);
  if (
    source.type === 'rss' ||
    (source.type === 'manufacturer' && source.settings.format !== 'json')
  ) {
    const batch = await feedConnector(source, request);
    if (source.type === 'manufacturer')
      batch.records = batch.records.map((r) => ({
        ...r,
        kind: 'manufacturer',
        body: '',
        product_label: r.title,
        facts: { publication_title: r.title },
      }));
    await onPage?.(batch);
    return batch;
  }
  if (source.type === 'approved-html')
    throw new CollectionError('html_requires_separate_parser_approval');
  return jsonConnector(source, request, onPage);
}
