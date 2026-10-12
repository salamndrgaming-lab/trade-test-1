import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface HttpRequest {
  /** logical service name, used for fixture file names */
  service: 'dexscreener' | 'rpc' | 'jupiter';
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** stable key for fixtures; secrets (API keys, RPC tokens) must not appear in it */
  key: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}

export interface Transport {
  send(req: HttpRequest): Promise<HttpResponse>;
}

const TIMEOUT_MS = 15_000;

export class LiveTransport implements Transport {
  async send(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: { accept: 'application/json', ...(req.body ? { 'content-type': 'application/json' } : {}), ...req.headers },
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, json };
  }
}

export function fixtureName(req: HttpRequest): string {
  const slug = req.key.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const h = createHash('sha1').update(req.key).digest('hex').slice(0, 8);
  return `${req.service}/${slug}-${h}.json`;
}

/** Records every live response to disk (headers stripped down to rate-limit ones). */
export class RecordingTransport implements Transport {
  constructor(private inner: Transport, private dir: string) {}
  async send(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.inner.send(req);
    const file = join(this.dir, fixtureName(req));
    mkdirSync(join(this.dir, req.service), { recursive: true });
    const keep = Object.fromEntries(Object.entries(res.headers).filter(([k]) => k.startsWith('x-ratelimit')));
    writeFileSync(file, JSON.stringify({ key: req.key, status: res.status, headers: keep, json: res.json }, null, 1));
    return res;
  }
}

/** Replays recorded responses. Development and tests only (config refuses it in production). */
export class FixtureTransport implements Transport {
  readonly misses: string[] = [];
  constructor(private dir: string) {}
  async send(req: HttpRequest): Promise<HttpResponse> {
    const file = join(this.dir, fixtureName(req));
    if (!existsSync(file)) {
      this.misses.push(req.key);
      return { status: 404, headers: {}, json: { error: `no fixture for ${req.key}` } };
    }
    const f = JSON.parse(readFileSync(file, 'utf8')) as { status: number; headers?: Record<string, string>; json: unknown };
    return { status: f.status, headers: f.headers ?? {}, json: f.json };
  }
}
