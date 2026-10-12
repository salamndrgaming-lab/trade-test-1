import { readEnv } from './config.js';
import { openDb, Repo } from './db/db.js';
import { FixtureTransport, LiveTransport, RecordingTransport, type Transport } from './http/transport.js';
import { log } from './log.js';
import { Pipeline } from './pipeline/tick.js';
import { buildServer } from './server.js';
import { DexScreener } from './sources/dexscreener.js';
import { Jupiter } from './sources/jupiter.js';
import { SolanaRpc } from './sources/solana.js';
import { LiveDesk } from './state/desk.js';

const env = readEnv();

if (env.mode === 'live') {
  const bar = '!'.repeat(64);
  log.warn(bar);
  log.warn('TRADING_MODE=live: this bot WILL sign and send real swaps with real money.');
  log.warn(bar);
} else {
  log.info('TRADING_MODE=shadow: quotes only, nothing is ever signed or sent.');
}

let transport: Transport = new LiveTransport();
if (env.dataSource === 'record') transport = new RecordingTransport(transport, env.fixturesDir);
if (env.dataSource === 'fixtures') {
  transport = new FixtureTransport(env.fixturesDir);
  log.warn('DATA_SOURCE=fixtures: replaying recorded API responses (development only).');
}

const repo = new Repo(openDb(env.dbPath));
const desk = new LiveDesk(repo, env.mode, env.tickMs);
const dex = new DexScreener(transport, env.dexBase, env.dexMaxPerMin);
const rpc = new SolanaRpc(transport, env.rpcUrl ?? 'http://fixtures.invalid');
const jupiter = new Jupiter(transport, env.jupBase, env.jupApiKey);
const pipeline = new Pipeline({ env, repo, desk, dex, rpc, jupiter });

const app = await buildServer({ snapshot: () => desk.snapshot() }, { allowedOrigin: env.allowedOrigin });
await app.listen({ host: env.host, port: env.port });
log.info('bot api listening', { host: env.host, port: env.port, dataSource: env.dataSource, wallet: env.walletPubkey ? 'configured' : 'none', jupiterAuth: env.jupApiKey ? 'api key' : 'keyless' });

/** Run `fn` every `ms`, never overlapping, never dying on an error. */
function every(ms: number, fn: () => Promise<unknown>) {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    const t0 = Date.now();
    try { await fn(); } catch (e) { log.error('loop error', { err: String(e) }); }
    if (!stopped) setTimeout(run, Math.max(1000, ms - (Date.now() - t0)));
  };
  void run();
  return () => { stopped = true; };
}

// balance first, so the first tick can size its quotes
await pipeline.refreshWallet().catch((e: unknown) => log.warn('initial wallet refresh failed', { err: String(e) }));

const stops = [
  every(5 * 60_000, () => pipeline.refreshWallet()),
  every(env.tickMs, () => pipeline.tick()),
  every(15_000, () => pipeline.sampleFocus()),
  every(3_600_000, async () => repo.pruneEvents(Date.now() - 7 * 86_400_000)),
];

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log.info('shutting down', { sig });
    stops.forEach((s) => s());
    await app.close();
    repo.db.close();
    process.exit(0);
  });
}
