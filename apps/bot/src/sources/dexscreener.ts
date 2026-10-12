import { z } from 'zod';
import { RateLimiter } from '../http/ratelimit.js';
import type { Transport } from '../http/transport.js';
import { ApiError, call } from './http.js';

const Window = z.object({ m5: z.number().optional(), h1: z.number().optional(), h6: z.number().optional(), h24: z.number().optional() }).partial();
const Txn = z.object({ buys: z.number().default(0), sells: z.number().default(0) });

export const DexPair = z.object({
  chainId: z.string(),
  dexId: z.string().default(''),
  url: z.string().optional(),
  pairAddress: z.string(),
  baseToken: z.object({ address: z.string(), name: z.string().default(''), symbol: z.string().default('') }),
  quoteToken: z.object({ address: z.string(), symbol: z.string().default('') }).partial().default({}),
  priceUsd: z.string().optional(),
  txns: z.object({ m5: Txn.optional(), h1: Txn.optional(), h6: Txn.optional(), h24: Txn.optional() }).optional(),
  volume: Window.optional(),
  priceChange: Window.optional(),
  liquidity: z.object({ usd: z.number().optional() }).partial().optional(),
  fdv: z.number().optional(),
  marketCap: z.number().optional(),
  pairCreatedAt: z.number().optional(),
  info: z
    .object({
      websites: z.array(z.object({ url: z.string(), label: z.string().optional() }).passthrough()).optional(),
      socials: z.array(z.object({ type: z.string().optional(), url: z.string() }).passthrough()).optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();
export type DexPair = z.infer<typeof DexPair>;

const Profile = z.object({
  chainId: z.string(),
  tokenAddress: z.string(),
  description: z.string().optional(),
  links: z.array(z.object({ type: z.string().optional(), label: z.string().optional(), url: z.string() }).passthrough()).optional(),
}).passthrough();
export type DexProfile = z.infer<typeof Profile>;

/** Lenient array parse: keep the items that validate, drop the rest. */
function items<T>(schema: z.ZodType<T>, json: unknown): T[] {
  if (!Array.isArray(json)) return [];
  const out: T[] = [];
  for (const it of json) {
    const r = schema.safeParse(it);
    if (r.success) out.push(r.data);
  }
  return out;
}

/**
 * DexScreener public API. One shared limiter keeps the whole bot under 60 requests/minute
 * (the profile/boost endpoints are capped at 60/min; pair endpoints allow more, we stay conservative).
 */
export class DexScreener {
  readonly limiter: RateLimiter;
  calls = 0;
  constructor(private transport: Transport, private base: string, maxPerMin = 55, limiter?: RateLimiter) {
    this.limiter = limiter ?? new RateLimiter(maxPerMin, 60_000);
  }

  private async get(path: string): Promise<unknown> {
    this.calls++;
    const res = await call(this.transport, this.limiter, { service: 'dexscreener', method: 'GET', url: this.base + path, key: `GET ${path}` });
    if (res.status !== 200) throw new ApiError(`DexScreener ${path} → HTTP ${res.status}`, res.status, res.json);
    return res.json;
  }

  async latestProfiles(): Promise<DexProfile[]> {
    return items(Profile, await this.get('/token-profiles/latest/v1')).filter((p) => p.chainId === 'solana');
  }

  async latestBoosts(): Promise<DexProfile[]> {
    return items(Profile, await this.get('/token-boosts/latest/v1')).filter((p) => p.chainId === 'solana');
  }

  /** One pair by address (used to sample the big-screen token's price). */
  async pair(pairAddress: string): Promise<DexPair | null> {
    const j = (await this.get(`/latest/dex/pairs/solana/${pairAddress}`)) as { pairs?: unknown[]; pair?: unknown } | null;
    const list = items(DexPair, j?.pairs ?? (j?.pair ? [j.pair] : []));
    return list[0] ?? null;
  }

  /** All Solana pairs for up to 30 mints per request. */
  async pairsForTokens(mints: string[]): Promise<DexPair[]> {
    const out: DexPair[] = [];
    for (let i = 0; i < mints.length; i += 30) {
      const batch = mints.slice(i, i + 30);
      out.push(...items(DexPair, await this.get(`/tokens/v1/solana/${batch.join(',')}`)).filter((p) => p.chainId === 'solana'));
    }
    return out;
  }
}

/** The pair we judge a token by: its deepest pool where the token is the base. */
export function bestPair(pairs: DexPair[], mint: string): DexPair | null {
  let best: DexPair | null = null;
  for (const p of pairs) {
    if (p.baseToken.address !== mint) continue;
    if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
  }
  return best;
}
