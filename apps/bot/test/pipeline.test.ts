import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/config.js';
import { openDb, Repo } from '../src/db/db.js';
import { RateLimiter } from '../src/http/ratelimit.js';
import { Pipeline } from '../src/pipeline/tick.js';
import { buildServer } from '../src/server.js';
import { DexScreener } from '../src/sources/dexscreener.js';
import { Jupiter } from '../src/sources/jupiter.js';
import { SolanaRpc } from '../src/sources/solana.js';
import { LiveDesk } from '../src/state/desk.js';
import { SCENARIO, SyntheticTransport, mintOf, wallet } from './synthetic.js';

function setup(now = 1_791_500_000_000) {
  const clock = { t: now };
  const transport = new SyntheticTransport(SCENARIO, () => clock.t);
  const env = readEnv({ DATA_SOURCE: 'fixtures', BOT_WALLET_PUBKEY: wallet(1), TICK_SECONDS: '60' });
  const repo = new Repo(openDb(':memory:'));
  const desk = new LiveDesk(repo, 'shadow', env.tickMs, now, () => clock.t);
  const fast = { now: () => clock.t, sleep: async () => undefined };
  const dex = new DexScreener(transport, 'https://api.dexscreener.com', 55, new RateLimiter(1000, 60_000, fast));
  const rpc = new SolanaRpc(transport, 'https://rpc.example.invalid/?api-key=SECRET');
  const jupiter = new Jupiter(transport, 'https://api.jup.ag/swap/v2', 'k');
  const pipeline = new Pipeline({ env, repo, desk, dex, rpc, jupiter, now: () => clock.t });
  return { clock, transport, repo, desk, pipeline };
}

describe('one full pipeline tick (synthetic API responses, no network)', () => {
  it('kills each bad token at the right step and keeps the clean one', async () => {
    const { pipeline, repo } = setup();
    await pipeline.refreshWallet();
    const report = await pipeline.tick();
    expect(report.errors).toEqual([]);
    expect(report.discovered).toBe(8); // the ethereum profile is ignored
    expect(report.evaluated).toBe(8);

    const died = Object.fromEntries(SCENARIO.map((t) => [t.symbol, repo.verdictFor(mintOf(t))?.diedAt ?? null]));
    expect(died).toEqual({
      BABY: 'free_kill', THIN: 'free_kill', WHALE: 'free_kill', QUIET: 'trade_kill',
      MINTY: 'chain_kill', TRAP: 'chain_kill', SLIP: 'chain_kill', CLEAN: null,
    });
    const stats = repo.dayStats(1_791_500_000_000);
    expect(stats.scanned).toBe(8);
    expect(stats.dropped).toMatchObject({ free_kill: 3, trade_kill: 1, chain_kill: 3 });
  });

  it('spends RPC and Jupiter calls only where the cheaper checks passed', async () => {
    const { pipeline, transport } = setup();
    await pipeline.refreshWallet();
    transport.calls = { dexscreener: 0, rpc: 0, jupiter: 0 };
    await pipeline.tick();
    // 3 RPC calls (mint, largest accounts, owners) for the 6 tokens past the cheap checks; 0 for BABY and THIN
    expect(transport.calls.rpc).toBe(6 * 3);
    // quotes only for TRAP, SLIP, CLEAN (buy + sell each); MINTY stops at the authority check
    expect(transport.calls.jupiter).toBe(6);
  });

  it('shows why each token died, with skipped checks marked as not run', async () => {
    const { pipeline, repo } = setup();
    await pipeline.refreshWallet();
    await pipeline.tick();
    const baby = repo.recentVerdicts(20).find((t) => t.symbol === 'BABY')!;
    expect(baby.verdictReason).toBe('free_kill: min_age_minutes');
    expect(baby.checks.find((c) => c.key === 'max_top_wallet')!.pass).toBeNull();
    const minty = repo.recentVerdicts(20).find((t) => t.symbol === 'MINTY')!;
    expect(minty.checks.find((c) => c.key === 'mint_revoked')!.pass).toBe(false);
    expect(minty.checks.find((c) => c.key === 'sell_routes')!.pass).toBeNull();
    const trap = repo.recentVerdicts(20).find((t) => t.symbol === 'TRAP')!;
    expect(trap.checks.find((c) => c.key === 'sell_routes')!.pass).toBe(false);
    const whale = repo.recentVerdicts(20).find((t) => t.symbol === 'WHALE')!;
    expect(whale.metrics.topWallet).toBeCloseTo(0.12, 3); // the pool vault (40%) is not counted
  });

  it('serves a real /state: no fake numbers, nothing key-shaped, RPC secret absent', async () => {
    const { pipeline, desk } = setup();
    await pipeline.refreshWallet();
    await pipeline.tick();
    const app = await buildServer({ snapshot: () => desk.snapshot() });
    const res = await app.inject({ method: 'GET', url: '/state' });
    const s = res.json();
    expect(s.source).toBe('live');
    expect(s.pipeline.scannedToday).toBeGreaterThan(0);
    expect(s.wallet.solBalance).toBe(5);
    expect(s.wallet.usdBalance).toBeCloseTo(751.25, 2);
    expect(s.ai.newTradesBlocked).toBe(true);
    expect(s.rails.buysAllowed).toBe(false);
    expect(s.events.length).toBeGreaterThan(10);
    const body = res.body;
    expect(body).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{80,}/); // base58 secret keys are 86–88 chars
    expect(body).not.toMatch(/\[(\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/); // 64-byte JSON key arrays
    expect(body).not.toContain('SECRET');
    expect(body).not.toContain('rpc.example');
  });

  it('defers quotes until there is a ticket size, instead of failing tokens', async () => {
    const { pipeline, repo } = setup();
    const report = await pipeline.tick(); // no refreshWallet: balance unknown
    expect(report.deferred).toBe(3); // TRAP, SLIP, CLEAN need quotes
    expect(repo.verdictFor(mintOf(SCENARIO[7]!))).toBeNull();
    expect(repo.verdictFor(mintOf(SCENARIO[4]!))?.diedAt).toBe('chain_kill'); // MINTY dies before quoting
  });

  it('a re-check that changes nothing does not replay the animation', async () => {
    const { pipeline, desk, clock } = setup();
    await pipeline.refreshWallet();
    await pipeline.tick();
    const n = desk.snapshot().events.length;
    clock.t += 6 * 60_000;
    await pipeline.tick();
    const after = desk.snapshot().events.filter((e) => e.kind === 'drop').length;
    expect(after).toBeLessThanOrEqual(n);
    expect(desk.snapshot().events.filter((e) => e.kind === 'token_found').length).toBe(8);
  });
});
