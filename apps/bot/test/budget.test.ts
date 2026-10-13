/**
 * Phase 3 "done" check: a busy day stays under the 10,000-neuron Workers AI allowance.
 * Runs the real pipeline (crawler → kill chain → Vet+Social → Chief) for 1,440 one-minute ticks against
 * SYNTHETIC API responses. AI usage is charged from the real prompt sizes (1 token per 4 chars) plus
 * conservative output sizes, through the real Workers AI client and neuron rates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAi } from '../src/ai/index.js';
import { readEnv } from '../src/config.js';
import { openDb, Repo } from '../src/db/db.js';
import { RateLimiter } from '../src/http/ratelimit.js';
import type { HttpRequest, HttpResponse, Transport } from '../src/http/transport.js';
import { Pipeline } from '../src/pipeline/tick.js';
import { DexScreener } from '../src/sources/dexscreener.js';
import { Jupiter } from '../src/sources/jupiter.js';
import { SolanaRpc } from '../src/sources/solana.js';
import { LiveDesk } from '../src/state/desk.js';
import { mulberry32 } from '../../../packages/shared/src/mock/rng.js';
import { offCurve, wallet } from './synthetic.js';

const SOL = 'So11111111111111111111111111111111111111112';
const SUPPLY = 1_000_000_000_000_000n;
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, json: body });

type Fate = 'free' | 'trade' | 'chain' | 'survive';
interface SimTok { id: number; mint: string; pair: string; born: number; price: number; fate: Fate; recycled: boolean; holders: string[] }

class SimTransport implements Transport {
  toks = new Map<string, SimTok>();
  byPair = new Map<string, SimTok>();
  byHolderAcct = new Map<string, { owner: string }>();
  ai = { score: 0, pick: 0, inTok: 0, outTok: 0 };
  private n = 0;
  constructor(private now: () => number, private rng: () => number) {}

  spawn(count: number) {
    for (let i = 0; i < count; i++) {
      const id = ++this.n;
      const r = this.rng();
      const fate: Fate = r < 0.5 ? 'free' : r < 0.7 ? 'trade' : r < 0.92 ? 'chain' : 'survive';
      const t: SimTok = { id, mint: `M${id}x`.padEnd(32, 'k'), pair: `P${id}x`.padEnd(32, 'q'), born: this.now(), price: 0.0005, fate, recycled: this.rng() < 0.3, holders: [] };
      for (let h = 0; h < 4; h++) {
        const acct = `A${id}h${h}`.padEnd(32, 'z');
        t.holders.push(acct);
        this.byHolderAcct.set(acct, { owner: wallet((id * 4 + h) % 50) });
      }
      this.byHolderAcct.set(`V${id}`.padEnd(32, 'v'), { owner: offCurve(id % 20) });
      this.toks.set(t.mint, t);
      this.byPair.set(t.pair, t);
    }
  }

  drift() {
    for (const t of this.toks.values()) t.price *= 1 + (this.rng() - 0.48) * 0.08;
  }

  private pair(t: SimTok) {
    const ageMin = (this.now() - t.born) / 60_000 + (t.fate === 'free' ? 0 : 30);
    const liq = t.fate === 'free' ? 4_000 : 45_000;
    const trades = t.fate === 'trade' ? 50 : 1500;
    return {
      chainId: 'solana', dexId: 'raydium', pairAddress: t.pair, url: '',
      baseToken: { address: t.mint, name: `Tok ${t.id}`, symbol: `T${t.id}` },
      quoteToken: { address: SOL, symbol: 'SOL' },
      priceUsd: String(t.price),
      txns: { h1: { buys: 60, sells: 40 }, h24: { buys: Math.round(trades * 0.55), sells: trades - Math.round(trades * 0.55) } },
      volume: { m5: 1000, h1: 15_000, h24: 250_000 }, priceChange: { m5: 3, h1: 20 },
      liquidity: { usd: liq }, marketCap: 400_000, fdv: 400_000, pairCreatedAt: this.now() - ageMin * 60_000,
      info: { socials: [{ type: 'twitter', url: `https://x.com/${t.recycled ? 'pumpteam' : `tok${t.id}`}` }], websites: [{ url: `https://tok${t.id}.fun` }] },
    };
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const u = new URL(req.url);
    if (req.service === 'dexscreener') {
      if (u.pathname.endsWith('/latest/v1')) {
        const recent = [...this.toks.values()].filter((t) => this.now() - t.born < 120_000);
        const feed = u.pathname.includes('boost') ? recent.filter((t) => t.id % 3 === 0) : recent.filter((t) => t.id % 3 !== 0);
        return json(200, feed.map((t) => ({ chainId: 'solana', tokenAddress: t.mint, description: `The one and only Tok ${t.id}.` })));
      }
      const m = /^\/tokens\/v1\/solana\/(.+)$/.exec(u.pathname);
      if (m) {
        const mints = decodeURIComponent(m[1]!).split(',');
        if (mints.includes(SOL)) return json(200, [{ chainId: 'solana', pairAddress: 'SOLUSDC', baseToken: { address: SOL, symbol: 'SOL', name: 'SOL' }, priceUsd: '150', liquidity: { usd: 1e8 } }]);
        return json(200, mints.flatMap((x) => (this.toks.has(x) ? [this.pair(this.toks.get(x)!)] : [])));
      }
      const p = /^\/latest\/dex\/pairs\/solana\/(.+)$/.exec(u.pathname);
      const t = p ? this.byPair.get(p[1]!) : undefined;
      return json(200, { pairs: t ? [this.pair(t)] : [] });
    }
    if (req.service === 'rpc') {
      const b = req.body as { id: number; method: string; params: unknown[] };
      const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id: b.id, result });
      if (b.method === 'getBalance') return ok({ value: 5_000_000_000 });
      const t = this.toks.get(b.params[0] as string);
      if (b.method === 'getAccountInfo') {
        const live = t?.fate === 'chain' && t.id % 2 === 0 ? wallet(7) : null;
        return ok({ value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 6, supply: SUPPLY.toString(), mintAuthority: live, freezeAuthority: null } } } } });
      }
      if (b.method === 'getTokenLargestAccounts') {
        const accts = [{ address: `V${t!.id}`.padEnd(32, 'v'), amount: ((SUPPLY * 40n) / 100n).toString() }, ...t!.holders.map((a) => ({ address: a, amount: ((SUPPLY * 3n) / 100n).toString() }))];
        return ok({ value: accts });
      }
      if (b.method === 'getMultipleAccounts') return ok({ value: (b.params[0] as string[]).map((a) => ({ data: { parsed: { info: { owner: this.byHolderAcct.get(a)?.owner } } } })) });
      return ok(null);
    }
    if (req.service === 'jupiter') {
      const input = u.searchParams.get('inputMint')!;
      const t = this.toks.get(input === SOL ? u.searchParams.get('outputMint')! : input);
      if (t?.fate === 'chain' && input !== SOL) return json(400, { error: 'No routes found' });
      return json(200, { outAmount: (BigInt(u.searchParams.get('amount')!) * 1000n).toString(), priceImpact: -0.9, router: 'metis' });
    }
    // ── AI: Workers AI. Usage = real prompt size; outputs sized generously. ──
    const body = req.body as { input?: { content: string }[]; messages?: { content: string }[] };
    const promptChars = JSON.stringify(body.input ?? body.messages).length;
    const inTok = Math.ceil(promptChars / 4);
    if (u.pathname.endsWith('/responses')) {
      this.ai.pick++;
      const out = 350; // low-effort reasoning + the JSON answer
      this.ai.inTok += inTok; this.ai.outTok += out;
      const mint = /"mint":"([^"]+)"/.exec(body.input![1]!.content)?.[1] ?? null;
      const text = JSON.stringify({ pick: mint, reason: 'Freshest momentum with room in the pool.', quote: 'Taking it. Size it up.' });
      return json(200, { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: inTok, output_tokens: out } });
    }
    this.ai.score++;
    const out = 160; // the eight-key JSON reply, thinking off
    this.ai.inTok += inTok; this.ai.outTok += out;
    const recycled = /Same handle on earlier tokens: \$/.test(body.messages![1]!.content);
    const text = JSON.stringify({ concentration_is_exit_risk: 0.25, momentum_already_spent: 0.35, liquidity_fits_ticket: 0.8, account_is_the_project: recycled ? 0.3 : 0.85, recycled_account: recycled ? 0.9 : 0.1, dev_still_loaded: 0.2, vet_quote: 'Holders spread out, pool deep.', social_quote: recycled ? 'Handle used before. Pass.' : 'Account is theirs.' });
    return json(200, { choices: [{ message: { content: text } }], usage: { prompt_tokens: inTok, completion_tokens: out } });
  }
}

describe('busy day AI budget (simulated 24 h, synthetic APIs)', () => {
  const clock = { t: Date.parse('2026-10-13T00:00:00Z') };
  // waiting on a rate limit moves simulated time forward, like real waiting would
  beforeAll(() => { RateLimiter.defaultClock = { now: () => clock.t, sleep: async (ms) => { clock.t += ms; } }; });
  afterAll(() => { RateLimiter.defaultClock = null; });

  it('stays under 10,000 Workers AI neurons and never needs the Groq fallback', async () => {
    const rng = mulberry32(42);
    const sim = new SimTransport(() => clock.t, rng);
    const env = readEnv({ DATA_SOURCE: 'fixtures', BOT_WALLET_PUBKEY: wallet(1), CF_ACCOUNT_ID: 'acct', CF_WORKERS_AI_TOKEN: 'tok' });
    const repo = new Repo(openDb(':memory:'));
    const desk = new LiveDesk(repo, 'shadow', env.tickMs, clock.t, () => clock.t);
    const { router, brain } = buildAi(env, repo, sim, () => clock.t);
    const now = () => clock.t;
    const pipeline = new Pipeline({ env, repo, desk, now, brain, dex: new DexScreener(sim, env.dexBase), rpc: new SolanaRpc(sim, 'http://sim'), jupiter: new Jupiter(sim, env.jupBase, 'k') });
    await pipeline.refreshWallet();

    let picks = 0;
    for (let minute = 0; minute < 1440; minute++) {
      sim.spawn(rng() < 0.1 ? 0 : 2 + Math.floor(rng() * 1.2)); // ~2.1 new tokens a minute ≈ 3,000 a day
      sim.drift();
      const r = await pipeline.tick();
      if (r.picked) picks++;
      clock.t += 60_000;
    }
    // total over the whole run (limiter waits can push the last ticks past midnight; this is stricter than per-day)
    const tot = repo.db.prepare("SELECT provider, SUM(neurons) n, SUM(calls) c FROM ai_usage GROUP BY provider").all() as { provider: string; n: number; c: number }[];
    const usage = Object.fromEntries(tot.map((r) => [r.provider, r]));
    const neurons = usage.workers_ai?.n ?? 0;
    const hours = (clock.t - Date.parse('2026-10-13T00:00:00Z')) / 3_600_000;
    const survivors = [...sim.toks.values()].filter((t) => t.fate === 'survive').length;
    process.stderr.write(`\nBUSY DAY:  ${sim.toks.size} tokens, ${survivors} reached the model, ${sim.ai.score} score calls, ${sim.ai.pick} Chief calls, ${picks} picks, ` +
      `${sim.ai.inTok} in / ${sim.ai.outTok} out tokens → ${Math.round(neurons)} neurons over ${hours.toFixed(1)} simulated hours\n`);
    expect(sim.toks.size).toBeGreaterThan(2500);
    expect(survivors).toBeGreaterThan(150);
    expect(sim.ai.score).toBeGreaterThan(survivors * 0.9); // every survivor was actually scored
    expect(picks).toBeGreaterThan(20);
    expect(neurons).toBeLessThan(10_000);
    expect(neurons).toBeLessThan(9_000); // under the 90% switch point: Groq never needed
    expect(usage.groq).toBeUndefined();
    expect(router.state().provider).toBe('workers_ai');
  }, 120_000);
});
