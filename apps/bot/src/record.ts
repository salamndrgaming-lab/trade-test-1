/**
 * Records one real pipeline tick as fixtures for the replay test:
 *   pnpm --filter @coin/bot record
 * Needs the same env as the bot (SOLANA_RPC_URL, BOT_WALLET_PUBKEY or QUOTE_TICKET_SOL, JUPITER_API_KEY).
 * Fixture keys never include the RPC URL or API keys; review the files before committing anyway.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnv } from './config.js';
import { openDb, Repo } from './db/db.js';
import { LiveTransport, RecordingTransport } from './http/transport.js';
import { log } from './log.js';
import { Pipeline } from './pipeline/tick.js';
import { DexScreener } from './sources/dexscreener.js';
import { Jupiter } from './sources/jupiter.js';
import { SolanaRpc } from './sources/solana.js';
import { LiveDesk } from './state/desk.js';

const dir = process.env.FIXTURES_DIR ?? 'test/fixtures/recorded';
const env = readEnv({ ...process.env, DATA_SOURCE: 'live' });
const now = Date.now();
const clock = () => now; // freeze time so the replay computes the same ages
const transport = new RecordingTransport(new LiveTransport(), dir);
const repo = new Repo(openDb(':memory:'));
const desk = new LiveDesk(repo, 'shadow', env.tickMs, now, clock);
const pipeline = new Pipeline({
  env, repo, desk, now: clock,
  dex: new DexScreener(transport, env.dexBase, env.dexMaxPerMin),
  rpc: new SolanaRpc(transport, env.rpcUrl!),
  jupiter: new Jupiter(transport, env.jupBase, env.jupApiKey),
});

await pipeline.refreshWallet();
const report = await pipeline.tick();
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'manifest.json'),
  JSON.stringify({ recordedAt: now, walletPubkey: env.walletPubkey, quoteTicketSol: env.quoteTicketSol, report, verdicts: repo.recentVerdicts(500).map((t) => ({ symbol: t.symbol, mint: t.mint, diedAt: t.diedAt })) }, null, 1),
);
log.info('recorded fixtures', { dir, evaluated: report.evaluated, dropped: report.dropped, survivors: report.survivors });
