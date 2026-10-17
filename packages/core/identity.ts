import { createHash } from 'node:crypto';
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function stableId(value: string) {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
export function canonicalUrl(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    !['fixtures.example.org'].includes(u.hostname)
  )
    throw new Error('Fixture URL is outside source allowlist');
  for (const k of [...u.searchParams.keys()])
    if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
  u.hash = '';
  u.searchParams.sort();
  return u.href;
}
export function safeLog(code: string, details: Record<string, unknown> = {}) {
  const allowed = ['job_id', 'state', 'count', 'attempts', 'error_code'];
  return JSON.stringify({
    code,
    ...Object.fromEntries(
      Object.entries(details).filter(([k]) => allowed.includes(k)),
    ),
  });
}
