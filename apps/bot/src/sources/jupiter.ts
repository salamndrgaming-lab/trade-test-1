import { RateLimiter } from '../http/ratelimit.js';
import type { Transport } from '../http/transport.js';
import { call } from './http.js';

export type Quote =
  | { ok: true; inAmount: bigint; outAmount: bigint; impactPct: number; router: string | null }
  | { ok: false; reason: 'no_route' | 'error'; detail: string };

/**
 * Jupiter Swap API v2. Phase 2 only quotes: `/order` without `taker` returns a quote and no transaction,
 * so nothing here can produce something signable.
 * Free plan: 1 request/second on a 60 s sliding window (keyless: 0.5/s).
 */
export class Jupiter {
  readonly limiter: RateLimiter;
  calls = 0;
  constructor(private transport: Transport, private base: string, private apiKey: string | null) {
    this.limiter = new RateLimiter(apiKey ? 60 : 30, 60_000);
  }

  async quote(inputMint: string, outputMint: string, amount: bigint): Promise<Quote> {
    this.calls++;
    const qs = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), swapMode: 'ExactIn' });
    const path = `/order?${qs}`;
    const res = await call(this.transport, this.limiter, {
      service: 'jupiter',
      method: 'GET',
      url: this.base + path,
      headers: this.apiKey ? { 'x-api-key': this.apiKey } : {},
      key: `GET ${path}`,
    });
    const j = (res.json ?? {}) as { outAmount?: string; inAmount?: string; priceImpact?: number; priceImpactPct?: string; router?: string; error?: string; errorMessage?: string };
    if (res.status === 200 && j.outAmount && BigInt(j.outAmount) > 0n) {
      // priceImpact is in percentage points (e.g. -0.1 = -0.1%); priceImpactPct is the deprecated ratio
      const impact = typeof j.priceImpact === 'number' ? j.priceImpact : j.priceImpactPct != null ? Number(j.priceImpactPct) * 100 : NaN;
      return { ok: true, inAmount: BigInt(j.inAmount ?? amount.toString()), outAmount: BigInt(j.outAmount), impactPct: Math.abs(impact), router: j.router ?? null };
    }
    const msg = j.error ?? j.errorMessage ?? `HTTP ${res.status}`;
    if (res.status === 400 || /no route|could not find any route/i.test(msg)) return { ok: false, reason: 'no_route', detail: msg };
    return { ok: false, reason: 'error', detail: msg };
  }
}
