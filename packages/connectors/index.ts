import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { sourceItem, type SourceItem } from '../contracts/index.js';
export interface Connector {
  discover(): Promise<unknown[]>;
  fetchMetadata(record: unknown): SourceItem;
  checkpoint(processed: number): string;
}
export class ConnectorError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const fixtureSources = [
  'fixture-json',
  'fixture-csv',
  'fixture-rss',
] as const;
export type FixtureSource = (typeof fixtureSources)[number];
export function fixtureConnector(source: string): Connector {
  if (!fixtureSources.includes(source as FixtureSource))
    throw new Error('Live connectors are disabled');
  return {
    async discover() {
      const path =
        source === 'fixture-json'
          ? 'forum.json'
          : source === 'fixture-csv'
            ? 'reviews.csv'
            : 'feed.xml';
      const text = await readFile(
        new URL(`../../fixtures/${path}`, import.meta.url),
        'utf8',
      );
      if (source === 'fixture-json') return JSON.parse(text) as unknown[];
      if (source === 'fixture-csv') {
        const rows = parse(text, {
          columns: true,
          skip_empty_lines: true,
        }) as Record<string, string>[];
        return rows.map((r) =>
          Object.fromEntries(
            Object.entries(r).map(([k, v]) => [
              k,
              [
                'first_hand',
                'sponsored',
                'explicit_rating',
                'player_type',
                'would_recommend',
                'worth_the_price',
              ].includes(k)
                ? (JSON.parse(v) as unknown)
                : v,
            ]),
          ),
        );
      }
      const parsed = new XMLParser({
        ignoreAttributes: true,
        processEntities: true,
      }).parse(text) as { rss: { channel: { item: { fixture: string }[] } } };
      return parsed.rss.channel.item.map(
        (i) => JSON.parse(i.fixture) as unknown,
      );
    },
    fetchMetadata(record) {
      return sourceItem.parse(record);
    },
    checkpoint(processed) {
      return `fixture-v1:${processed}`;
    },
  };
}
