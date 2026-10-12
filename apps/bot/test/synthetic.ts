/**
 * SYNTHETIC API responses for tests, shaped after the documented schemas
 * (DexScreener pair/profile objects, Solana JSON-RPC jsonParsed results, Jupiter Swap v2 /order).
 * They are not recordings. Real recordings go in test/fixtures/recorded via `pnpm --filter @coin/bot record`.
 * Test-only: nothing in src/ imports this file.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import type { HttpRequest, HttpResponse, Transport } from '../src/http/transport.js';

const SOL = 'So11111111111111111111111111111111111111112';

/** Deterministic on-curve wallet address (a real ed25519 public key). */
export function wallet(n: number): string {
  const seed = new Uint8Array(32).fill(n + 1);
  return bs58.encode(ed25519.getPublicKey(seed));
}

/** Deterministic 32-byte address that is NOT a valid ed25519 point (like a PDA). */
export function offCurve(n: number): string {
  for (let i = 0; i < 10_000; i++) {
    const b = new Uint8Array(32).map((_, j) => (n * 131 + i * 7 + j * 13) & 255);
    try { ed25519.Point.fromBytes(b); } catch { return bs58.encode(b); }
  }
  throw new Error('no off-curve bytes found');
}

export interface Tok {
  id: number;
  symbol: string;
  ageMin: number;
  liq: number;
  vol24: number;
  mcap: number;
  trades24: number;
  /** holder shares (excluding the pool), largest first */
  holders: number[];
  mintAuth: boolean;
  freezeAuth: boolean;
  buyImpact: number | null; // null = no buy route
  sellImpact: number | null; // null = no sell route
  feed: 'profile' | 'boost';
}

export const mintOf = (t: Tok) => wallet(1000 + t.id);
export const pairOf = (t: Tok) => offCurve(2000 + t.id);

const good = { ageMin: 90, liq: 40_000, vol24: 250_000, mcap: 400_000, trades24: 1200, holders: [0.03, 0.025, 0.02, 0.02, 0.015, 0.01, 0.01, 0.01, 0.01, 0.01], mintAuth: false, freezeAuth: false, buyImpact: 0.8, sellImpact: 1.1 };

/** One token per way to die, plus one survivor. */
export const SCENARIO: Tok[] = [
  { id: 1, symbol: 'BABY', ...good, ageMin: 6, feed: 'profile' },
  { id: 2, symbol: 'THIN', ...good, liq: 3_000, feed: 'profile' },
  { id: 3, symbol: 'WHALE', ...good, holders: [0.12, 0.03, 0.02], feed: 'profile' },
  { id: 4, symbol: 'QUIET', ...good, trades24: 40, feed: 'profile' },
  { id: 5, symbol: 'MINTY', ...good, mintAuth: true, feed: 'profile' },
  { id: 6, symbol: 'TRAP', ...good, sellImpact: null, feed: 'boost' },
  { id: 7, symbol: 'SLIP', ...good, sellImpact: 6.2, feed: 'boost' },
  { id: 8, symbol: 'CLEAN', ...good, feed: 'boost' },
];

const SUPPLY = 1_000_000_000_000_000n; // 1e9 tokens at 6 decimals
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, json: body });

export function pairJson(t: Tok, now: number) {
  const buys = Math.round(t.trades24 * 0.55);
  return {
    chainId: 'solana', dexId: 'raydium', url: `https://dexscreener.com/solana/${pairOf(t)}`, pairAddress: pairOf(t),
    baseToken: { address: mintOf(t), name: `${t.symbol} Token`, symbol: t.symbol },
    quoteToken: { address: SOL, name: 'Wrapped SOL', symbol: 'SOL' },
    priceNative: '0.0000031', priceUsd: '0.000512',
    txns: { m5: { buys: 6, sells: 4 }, h1: { buys: 60, sells: 40 }, h6: { buys: 300, sells: 200 }, h24: { buys, sells: t.trades24 - buys } },
    volume: { m5: 1500, h1: 18_000, h6: 90_000, h24: t.vol24 },
    priceChange: { m5: 2.1, h1: 14.5, h6: 30, h24: 80 },
    liquidity: { usd: t.liq, base: 1, quote: 1 },
    fdv: t.mcap, marketCap: t.mcap,
    pairCreatedAt: now - t.ageMin * 60_000,
    info: { socials: [{ type: 'twitter', url: `https://x.com/${t.symbol.toLowerCase()}coin` }], websites: [] },
  };
}

/** Routes requests to synthetic responses. Counts calls per service. */
export class SyntheticTransport implements Transport {
  calls = { dexscreener: 0, rpc: 0, jupiter: 0 };
  constructor(private toks: Tok[], private now: () => number) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    this.calls[req.service]++;
    const byMint = new Map(this.toks.map((t) => [mintOf(t), t]));
    const u = new URL(req.url);

    if (req.service === 'dexscreener') {
      if (u.pathname === '/token-profiles/latest/v1')
        return json(200, [
          ...this.toks.filter((t) => t.feed === 'profile').map((t) => ({ chainId: 'solana', tokenAddress: mintOf(t), url: '', links: [] })),
          { chainId: 'ethereum', tokenAddress: '0xdeadbeef', url: '' },
        ]);
      if (u.pathname === '/token-boosts/latest/v1')
        return json(200, this.toks.filter((t) => t.feed === 'boost').map((t) => ({ chainId: 'solana', tokenAddress: mintOf(t), amount: 10, totalAmount: 10 })));
      const m = /^\/tokens\/v1\/solana\/(.+)$/.exec(u.pathname);
      if (m) {
        const mints = decodeURIComponent(m[1]!).split(',');
        if (mints.includes(SOL)) return json(200, [{ ...pairJson({ ...SCENARIO[7]!, id: 99, symbol: 'SOL' }, this.now()), baseToken: { address: SOL, name: 'Wrapped SOL', symbol: 'SOL' }, priceUsd: '150.25' }]);
        return json(200, mints.flatMap((x) => (byMint.has(x) ? [pairJson(byMint.get(x)!, this.now())] : [])));
      }
      const p = /^\/latest\/dex\/pairs\/solana\/(.+)$/.exec(u.pathname);
      if (p) {
        const t = this.toks.find((x) => pairOf(x) === p[1]);
        return json(200, { schemaVersion: '1.0.0', pairs: t ? [pairJson(t, this.now())] : [] });
      }
      return json(404, { error: 'not found' });
    }

    if (req.service === 'rpc') {
      const body = req.body as { id: number; method: string; params: unknown[] };
      const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id: body.id, result });
      const ctx = { slot: 1 };
      if (body.method === 'getAccountInfo') {
        const t = byMint.get(body.params[0] as string);
        if (!t) return ok({ context: ctx, value: null });
        return ok({ context: ctx, value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 1, executable: false, data: { program: 'spl-token', space: 82, parsed: { type: 'mint', info: { decimals: 6, supply: SUPPLY.toString(), isInitialized: true, mintAuthority: t.mintAuth ? wallet(5000 + t.id) : null, freezeAuthority: t.freezeAuth ? wallet(6000 + t.id) : null } } } } });
      }
      if (body.method === 'getTokenLargestAccounts') {
        const t = byMint.get(body.params[0] as string)!;
        // the pool vault is the largest account; it must be excluded from concentration
        const pool = { address: offCurve(7000 + t.id), amount: ((SUPPLY * 40n) / 100n).toString(), decimals: 6 };
        const rest = t.holders.map((h, i) => ({ address: offCurve(8000 + t.id * 50 + i), amount: BigInt(Math.round(h * 1e6)) * (SUPPLY / 1_000_000n) + '', decimals: 6 }));
        return ok({ context: ctx, value: [pool, ...rest].map((a) => ({ ...a, uiAmount: 0, uiAmountString: '0' })) });
      }
      if (body.method === 'getMultipleAccounts') {
        const addrs = body.params[0] as string[];
        return ok({
          context: ctx,
          value: addrs.map((a) => {
            const pool = this.toks.find((t) => offCurve(7000 + t.id) === a);
            if (pool) return { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'account', info: { owner: offCurve(9000 + pool.id) } } } };
            const t = this.toks.find((x) => x.holders.some((_, i) => offCurve(8000 + x.id * 50 + i) === a));
            const i = t ? t.holders.findIndex((_, k) => offCurve(8000 + t.id * 50 + k) === a) : 0;
            return { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'account', info: { owner: wallet(10_000 + (t?.id ?? 0) * 50 + i) } } } };
          }),
        });
      }
      if (body.method === 'getBalance') return ok({ context: ctx, value: 5_000_000_000 });
      return json(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
    }

    // jupiter /order without taker: quote only
    const input = u.searchParams.get('inputMint')!;
    const output = u.searchParams.get('outputMint')!;
    const amount = u.searchParams.get('amount')!;
    if (u.searchParams.has('taker')) throw new Error('phase 2 must never send a taker');
    const buying = input === SOL;
    const t = byMint.get(buying ? output : input);
    const impact = t ? (buying ? t.buyImpact : t.sellImpact) : null;
    if (!t || impact === null) return json(400, { error: 'No routes found' });
    return json(200, { mode: 'ultra', inputMint: input, outputMint: output, inAmount: amount, outAmount: (BigInt(amount) * 1000n).toString(), priceImpact: -impact, router: 'metis', transaction: null, requestId: 'r1', swapType: 'aggregator' });
  }
}
