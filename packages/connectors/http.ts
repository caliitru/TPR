import { lookup } from 'node:dns/promises';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
export class CollectionError extends Error {
  constructor(
    public code: string,
    public retryAfterSeconds?: number,
  ) {
    super(code);
  }
}
export interface HttpRequest {
  url: string;
  headers?: Record<string, string>;
  quotaUnits?: number;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HttpTransport {
  readonly mode: 'mock' | 'live';
  request(input: HttpRequest): Promise<HttpResponse>;
}
export function allowedUrl(
  value: string,
  hosts: string[],
  allowFragment = false,
): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new CollectionError('invalid_url');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    (!allowFragment && u.hash) ||
    u.hostname.endsWith('.') ||
    !hosts.includes(u.hostname) ||
    ipaddr.isValid(u.hostname.replace(/^\[|\]$/g, '')) ||
    /(^|\.)(localhost|local|internal|invalid|test)$/.test(u.hostname)
  )
    throw new CollectionError('destination_denied');
  return u;
}
export const publicAddress = (address: string) => {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
};
export type Resolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;
export async function resolvePublic(
  url: URL,
  resolver: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      resolver(url.hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CollectionError('dns_timeout')),
          3000,
        );
      }),
    ]);
    if (
      !results.length ||
      results.some(
        (r) => !publicAddress(r.address) || ![4, 6].includes(r.family),
      )
    )
      throw new CollectionError('ssrf_denied');
    return results[0]!;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// No application entry point enables this transport. A later separately approved release must supply activation.
export class PinnedHttpsTransport implements HttpTransport {
  readonly mode = 'live' as const;
  constructor(
    private allowedHosts: string[],
    private activated = false,
    private resolver?: Resolver,
    private timeoutMs = 8000,
    private maxBytes = 1_000_000,
  ) {}
  async request(input: HttpRequest): Promise<HttpResponse> {
    if (!this.activated) throw new CollectionError('live_collection_disabled');
    const url = allowedUrl(input.url, this.allowedHosts);
    const pinned = await resolvePublic(url, this.resolver);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: HttpResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      const req = https.request(
        url,
        {
          method: 'GET',
          family: pinned.family,
          headers: {
            accept:
              'application/json, application/rss+xml, application/atom+xml',
            'accept-encoding': 'identity',
            'user-agent': 'TPR-Content-Intelligence/0.2',
            ...input.headers,
          },
          servername: url.hostname,
          lookup: (_hostname, _options, callback) =>
            callback(null, pinned.address, pinned.family),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && status !== 304) {
            res.destroy();
            finish(new CollectionError('redirect_denied'));
            return;
          }
          if (
            res.headers['content-encoding'] &&
            res.headers['content-encoding'] !== 'identity'
          ) {
            res.destroy();
            finish(new CollectionError('encoded_response_denied'));
            return;
          }
          if (Number(res.headers['content-length'] ?? 0) > this.maxBytes) {
            res.destroy();
            finish(new CollectionError('response_too_large'));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.maxBytes) {
              res.destroy();
              finish(new CollectionError('response_too_large'));
            } else chunks.push(chunk);
          });
          res.on('end', () =>
            finish(undefined, {
              status,
              headers: Object.fromEntries(
                Object.entries(res.headers).filter(
                  (e): e is [string, string] => typeof e[1] === 'string',
                ),
              ),
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', () => finish(new CollectionError('response_failed')));
        },
      );
      const timer = setTimeout(() => {
        finish(new CollectionError('timeout'));
        req.destroy();
      }, this.timeoutMs);
      req.on('error', () => finish(new CollectionError('network_failed')));
      req.end();
    });
  }
}
export class MockTransport implements HttpTransport {
  readonly mode = 'mock' as const;
  readonly requests: HttpRequest[] = [];
  constructor(
    private respond: (
      input: HttpRequest,
      index: number,
    ) => HttpResponse | Promise<HttpResponse>,
  ) {}
  async request(input: HttpRequest) {
    this.requests.push(input);
    return this.respond(input, this.requests.length - 1);
  }
}
export function validateResponse(response: HttpResponse, maxBytes = 1_000_000) {
  if (Buffer.byteLength(response.body) > maxBytes)
    throw new CollectionError('response_too_large');
  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.status !== 304
  )
    throw new CollectionError('redirect_denied');
  if (
    response.headers['content-encoding'] &&
    response.headers['content-encoding'] !== 'identity'
  )
    throw new CollectionError('encoded_response_denied');
  if (![200, 304].includes(response.status)) {
    const header = response.headers['retry-after'];
    const seconds =
      header && /^\d+$/.test(header)
        ? Math.min(86400, Number(header))
        : undefined;
    throw new CollectionError(String(response.status), seconds);
  }
}
