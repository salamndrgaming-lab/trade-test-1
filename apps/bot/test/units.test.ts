import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/config.js';
import { openDb, Repo } from '../src/db/db.js';
import { RateLimiter } from '../src/http/ratelimit.js';
import { log } from '../src/log.js';
import { ticketLamports } from '../src/pipeline/evaluate.js';
import { momentum, xHandle } from '../src/pipeline/metrics.js';
import { bestPair, DexPair } from '../src/sources/dexscreener.js';
import { Jupiter } from '../src/sources/jupiter.js';
import { isOnCurve } from '../src/sources/solana.js';
import type { HttpResponse, Transport } from '../src/http/transport.js';
import { SCENARIO, offCurve, pairJson, wallet } from './synthetic.js';

describe('config', () => {
  const base = { SOLANA_RPC_URL: 'https://rpc.example.com', QUOTE_TICKET_SOL: '0.1' };
  it('defaults to shadow', () => expect(readEnv(base).mode).toBe('shadow'));
  it('rejects unknown modes', () => expect(() => readEnv({ ...base, TRADING_MODE: 'yolo' })).toThrow());
  it('refuses fixture replay in production', () => expect(() => readEnv({ ...base, NODE_ENV: 'production', DATA_SOURCE: 'fixtures' })).toThrow(/development only/));
  it('needs an RPC URL for live data', () => expect(() => readEnv({ QUOTE_TICKET_SOL: '0.1' })).toThrow(/SOLANA_RPC_URL/));
  it('needs a wallet or a quote ticket', () => expect(() => readEnv({ SOLANA_RPC_URL: 'https://rpc.example.com' })).toThrow(/BOT_WALLET_PUBKEY/));
});

describe('log redaction', () => {
  it('drops query strings from URLs and secret-named fields', () => {
    const r = log.redact({ rpc: 'https://rpc.example.com/?api-key=abc123', apiKey: 'xyz' }) as Record<string, string>;
    expect(r.rpc).toBe('https://rpc.example.com/?[redacted]');
    expect(r.apiKey).toBe('[redacted]');
  });
});

describe('rate limiter', () => {
  it('never allows more than max calls in a window', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const clock = { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
    const rl = new RateLimiter(3, 1000, clock);
    const times: number[] = [];
    for (let i = 0; i < 7; i++) { await rl.take(); times.push(t); }
    for (let i = 0; i < times.length; i++) {
      expect(times.filter((x) => x > times[i]! - 1000 && x <= times[i]!).length).toBeLessThanOrEqual(3);
    }
    expect(times.at(-1)).toBeGreaterThanOrEqual(2000);
  });
  it('honours a server pause', async () => {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    const rl = new RateLimiter(10, 1000, clock);
    rl.pauseUntil(5000);
    await rl.take();
    expect(t).toBeGreaterThanOrEqual(5000);
  });
});

describe('DexScreener parsing', () => {
  const now = 1_791_500_000_000;
  it('picks the deepest pool where the token is the base', () => {
    const a = DexPair.parse(pairJson(SCENARIO[7]!, now));
    const b = DexPair.parse({ ...pairJson(SCENARIO[7]!, now), pairAddress: 'deeper', liquidity: { usd: 999_999 } });
    const c = DexPair.parse({ ...pairJson(SCENARIO[7]!, now), pairAddress: 'quoteside', baseToken: { address: 'other', name: '', symbol: '' }, liquidity: { usd: 5e6 } });
    expect(bestPair([a, b, c], a.baseToken.address)?.pairAddress).toBe('deeper');
  });
  it('momentum is 0–1 and rises with price and volume', () => {
    const flat = DexPair.parse({ ...pairJson(SCENARIO[7]!, now), priceChange: { m5: 0, h1: 0 }, volume: { h1: 100, h24: 100_000 } });
    const hot = DexPair.parse({ ...pairJson(SCENARIO[7]!, now), priceChange: { m5: 15, h1: 80 }, volume: { h1: 20_000, h24: 100_000 } });
    expect(momentum(flat)).toBeGreaterThanOrEqual(0);
    expect(momentum(hot)).toBeLessThanOrEqual(1);
    expect(momentum(hot)).toBeGreaterThan(momentum(flat));
  });
  it('reads the X handle from socials', () => {
    expect(xHandle(DexPair.parse(pairJson(SCENARIO[0]!, now)))).toBe('babycoin');
    expect(xHandle(DexPair.parse({ ...pairJson(SCENARIO[0]!, now), info: { socials: [{ type: 'twitter', url: 'https://twitter.com/@Some_One?s=20' }] } }))).toBe('some_one');
  });
});

describe('on-curve check (excludes PDAs from holder concentration)', () => {
  it('real public keys are on the curve; PDA-like bytes are not', () => {
    expect(isOnCurve(wallet(1))).toBe(true);
    expect(isOnCurve(offCurve(1))).toBe(false);
    expect(isOnCurve('not-base58!')).toBe(false);
  });
});

describe('Jupiter quotes (quote-only, no taker)', () => {
  const t = (res: HttpResponse[]): Transport & { urls: string[] } => {
    const urls: string[] = [];
    return { urls, send: async (r) => { urls.push(r.url); return res.shift()!; } };
  };
  it('reads priceImpact in percentage points', async () => {
    const tr = t([{ status: 200, headers: {}, json: { outAmount: '500', inAmount: '100', priceImpact: -1.25, router: 'metis', transaction: null } }]);
    const q = await new Jupiter(tr, 'https://api.jup.ag/swap/v2', 'k').quote('A', 'B', 100n);
    expect(q).toMatchObject({ ok: true, outAmount: 500n, impactPct: 1.25 });
    expect(tr.urls[0]).not.toContain('taker');
  });
  it('treats 400 "No routes found" as no route', async () => {
    const q = await new Jupiter(t([{ status: 400, headers: {}, json: { error: 'No routes found' } }]), 'https://x', null).quote('A', 'B', 1n);
    expect(q).toMatchObject({ ok: false, reason: 'no_route' });
  });
  it('retries once after a 429', async () => {
    const q = await new Jupiter(t([
      { status: 429, headers: { 'x-ratelimit-reset': '1' }, json: {} },
      { status: 200, headers: {}, json: { outAmount: '9', priceImpact: 0 } },
    ]), 'https://x', 'k').quote('A', 'B', 1n);
    expect(q.ok).toBe(true);
  });
});

describe('ticket size', () => {
  it('is 2% of the wallet', () => expect(ticketLamports(5, null)).toBe(100_000_000n));
  it('falls back to the configured quote ticket without a wallet', () => expect(ticketLamports(null, 0.05)).toBe(50_000_000n));
});

describe('database', () => {
  it('migrates and counts today by kill step', () => {
    const repo = new Repo(openDb(':memory:'));
    expect(repo.db.pragma('user_version', { simple: true })).toBe(1);
    const tables = (repo.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['tokens', 'verdicts', 'handles_seen', 'trades', 'balance_snapshots', 'agent_events', 'ai_usage', 'settings']) expect(tables).toContain(t);
  });
});
