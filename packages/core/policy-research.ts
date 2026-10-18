import { allowedUrl } from '../connectors/http.js';
import { spawn } from 'node:child_process';
import { hash } from './identity.js';
import type { PolicyEvidence } from '../contracts/source-assessment.js';
/** Policy navigation only: this transport cannot authorize collection or persist source bodies. */
export async function researchPolicy(
  urlValue: string,
  allowedHosts: string[],
  now = new Date(),
): Promise<PolicyEvidence> {
  const url = allowedUrl(urlValue, allowedHosts);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !allowedHosts.includes(url.hostname)
  )
    throw new Error('Policy URL is outside the explicit research allowlist');
  const result = await new Promise<{ exit: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        'curl',
        [
          '--silent',
          '--show-error',
          '--proto',
          '=https',
          '--max-redirs',
          '0',
          '--max-time',
          '20',
          '--connect-timeout',
          '8',
          '--max-filesize',
          '524288',
          '--user-agent',
          'TPR-PolicyAssessment/0.1',
          '--write-out',
          '\nTPR_POLICY_META:%{http_code}:%{http_connect}',
          url.href,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 530000) child.kill('SIGTERM');
        else chunks.push(chunk);
      });
      // Never retain proxy credentials, cookies, response headers or stderr diagnostics.
      child.stderr.resume();
      child.once('error', reject);
      child.once('close', (exit) =>
        resolve({ exit, output: Buffer.concat(chunks).toString('utf8') }),
      );
    },
  );
  return parsePolicyEvidence(
    url.href,
    allowedHosts,
    result.output,
    result.exit,
    now,
  );
}
export function parsePolicyEvidence(
  urlValue: string,
  allowedHosts: string[],
  output: string,
  exit: number | null,
  now = new Date(),
): PolicyEvidence {
  const url = new URL(urlValue);
  const attempted_at = now.toISOString();
  const marker = output.lastIndexOf('\nTPR_POLICY_META:');
  const body = marker < 0 ? '' : output.slice(0, marker),
    meta = marker < 0 ? [] : output.slice(marker + 17).split(':');
  const origin = Number(meta[0]) || null,
    proxy = Number(meta[1]) || null;
  const base = {
    url: url.href,
    attempted_at,
    origin_status: origin,
    proxy_connect_status: proxy,
    content_sha256: null,
    discovered_policy_links: [],
  };
  if (proxy === 403 || proxy === 407)
    return {
      ...base,
      origin_status: null,
      outcome: 'proxy_connect_denied',
      note: 'Environment CONNECT proxy denied the request before source access; this is not a publisher permission finding.',
    };
  if (origin && origin >= 300 && origin < 400)
    return {
      ...base,
      outcome: 'redirect_requires_review',
      note: 'No redirect followed. Review and explicitly allow the official destination before retrying.',
    };
  if (origin === 401 || origin === 403 || origin === 429)
    return {
      ...base,
      outcome: 'origin_denied',
      note: 'Origin denied or rate-limited policy navigation; no bypass or collection attempted.',
    };
  if (exit !== 0 || !origin || origin >= 400)
    return {
      ...base,
      outcome: 'network_error',
      note: 'Policy document was not retrieved; commercial rights remain unverified.',
    };
  const links: string[] = [];
  for (const match of body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const found = new URL(match[1]!, url);
      if (
        found.protocol === 'https:' &&
        !found.username &&
        !found.password &&
        /terms|legal|licens|copyright|developers|\/feed\b|rss/i.test(
          found.pathname,
        ) &&
        allowedHosts.includes(found.hostname)
      )
        links.push(found.href);
    } catch {
      /* malformed markup is not evidence */
    }
  }
  return {
    ...base,
    outcome: 'retrieved_for_review',
    content_sha256: hash(body),
    discovered_policy_links: [...new Set(links)].slice(0, 30),
    note: 'Retrieved for human policy review only. HTTP success and discovered feed/terms links do not establish commercial permission. Body discarded.',
  };
}
