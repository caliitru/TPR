import { hash } from './identity.js';
import type { ExternalRecord } from '../contracts/sources.js';
export function normalizedContentUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href.replace(/\/(?=\?|$)/, '');
}
export function contentIdentity(
  record: ExternalRecord,
  source: string,
  canonicalLabels?: string[],
) {
  const text = record.body.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const evidence =
    text || record.facts
      ? hash(
          JSON.stringify({
            body: text,
            structured: record.structured,
            facts: record.facts ?? null,
            kind: record.kind,
          }),
        )
      : null;
  const labels = [
    ...new Set(
      (
        canonicalLabels ??
        record.product_labels ?? [record.product_label || record.title]
      ).map((s) => s.normalize('NFKC').toLowerCase().trim()),
    ),
  ].sort();
  return {
    content: evidence ? hash(`${evidence}:${JSON.stringify(labels)}`) : null,
    experience: record.experience_id
      ? hash(`${source}:${record.experience_id}`)
      : null,
    // Exact repeated evidence is conservatively treated as one experience across publishers.
    observation:
      evidence ??
      hash(`${source}:${record.experience_id ?? record.external_id}`),
    revision:
      evidence ??
      hash(
        JSON.stringify({
          title: record.title,
          structured: record.structured,
          kind: record.kind,
        }),
      ),
  };
}
