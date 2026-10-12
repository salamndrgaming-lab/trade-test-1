import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/config.js';
import { openDb, Repo } from '../src/db/db.js';
import { RateLimiter } from '../src/http/ratelimit.js';
import { FixtureTransport } from '../src/http/transport.js';
import { Pipeline } from '../src/pipeline/tick.js';
import { DexScreener } from '../src/sources/dexscreener.js';
import { Jupiter } from '../src/sources/jupiter.js';
import { SolanaRpc } from '../src/sources/solana.js';
import { LiveDesk } from '../src/state/desk.js';

const DIR = 'test/fixtures/recorded';
const manifest = existsSync(`${DIR}/manifest.json`)
  ? (JSON.parse(readFileSync(`${DIR}/manifest.json`, 'utf8')) as { recordedAt: number; walletPubkey: string | null; quoteTicketSol: number | null; verdicts: { mint: string; diedAt: string | null }[] })
  : null;

/** Replays a real recorded tick (pnpm --filter @coin/bot record). Skipped until a recording exists. */
describe.skipIf(!manifest)('pipeline tick against recorded API fixtures', () => {
  it('reproduces the recorded verdicts with no network', async () => {
    const m = manifest!;
    const clock = () => m.recordedAt;
    const transport = new FixtureTransport(DIR);
    const env = readEnv({ DATA_SOURCE: 'fixtures', FIXTURES_DIR: DIR, ...(m.walletPubkey ? { BOT_WALLET_PUBKEY: m.walletPubkey } : {}), ...(m.quoteTicketSol ? { QUOTE_TICKET_SOL: String(m.quoteTicketSol) } : {}) });
    const repo = new Repo(openDb(':memory:'));
    const fast = { now: clock, sleep: async () => undefined };
    const pipeline = new Pipeline({
      env, repo, now: clock, desk: new LiveDesk(repo, 'shadow', env.tickMs, m.recordedAt, clock),
      dex: new DexScreener(transport, env.dexBase, 55, new RateLimiter(1e6, 60_000, fast)),
      rpc: new SolanaRpc(transport, 'http://fixtures.invalid'),
      jupiter: new Jupiter(transport, env.jupBase, env.jupApiKey),
    });
    await pipeline.refreshWallet();
    await pipeline.tick();
    expect(transport.misses).toEqual([]);
    for (const v of m.verdicts) expect(repo.verdictFor(v.mint)?.diedAt ?? null).toBe(v.diedAt);
  });
});
