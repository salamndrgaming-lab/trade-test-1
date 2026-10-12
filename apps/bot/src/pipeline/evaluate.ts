import { evaluateChain, HARD, type CheckResult, type KillStep, type TokenAnalysis, type TokenMetrics } from '@coin/shared';
import { RAILS } from '../config.js';
import type { DexPair } from '../sources/dexscreener.js';
import type { Jupiter } from '../sources/jupiter.js';
import { SOL_MINT, type SolanaRpc } from '../sources/solana.js';
import { log } from '../log.js';
import { metricsFromPair, momentum } from './metrics.js';

export interface EvalDeps {
  rpc: SolanaRpc;
  jupiter: Jupiter;
  holdersViaGpa: boolean;
}

/** What one evaluation cost, for the budget log. */
export interface EvalCost { rpc: number; jupiter: number }

/** The arithmetic checks DexScreener alone can answer (no RPC needed). */
function cheapFreeFails(m: TokenMetrics): boolean {
  return m.ageMinutes < HARD.min_age_minutes || m.liquidityUsd < HARD.min_liquidity_usd || m.mcapUsd < HARD.min_mcap_usd;
}

function finish(token: Omit<TokenAnalysis, 'checks' | 'diedAt' | 'verdict' | 'verdictReason'>, upTo: KillStep, skipped: Set<string>): TokenAnalysis {
  const r = evaluateChain(token.metrics, null, upTo);
  // checks we deliberately did not run (an earlier check in the same step already failed) show as skipped
  const checks: CheckResult[] = r.checks.map((c) => (skipped.has(c.key) && c.value === null ? { ...c, pass: null } : c));
  if (r.diedAt) {
    const failed = checks.filter((c) => c.step === r.diedAt && c.pass === false).map((c) => c.key);
    return { ...token, checks, diedAt: r.diedAt, verdict: 'dropped', verdictReason: `${r.diedAt}: ${failed.join(', ')}` };
  }
  return { ...token, checks, diedAt: null, verdict: 'pending', verdictReason: 'Passed chain_kill. Waiting for the model scores (phase 3).' };
}

/**
 * Run free_kill → trade_kill → chain_kill for one token, spending RPC and Jupiter calls only when
 * the cheaper checks have passed. Quotes are taken without a taker, so no transaction is ever built.
 * Returns null when the token needs quotes but there is no ticket size yet (no wallet balance): try again later.
 */
export async function evaluateToken(deps: EvalDeps, mint: string, pair: DexPair, ticketLamports: bigint, now: number): Promise<TokenAnalysis | null> {
  const m = metricsFromPair(pair, now);
  const base = {
    mint,
    symbol: pair.baseToken.symbol || mint.slice(0, 4),
    name: pair.baseToken.name || '',
    pairAddress: pair.pairAddress,
    dexUrl: pair.url ?? `https://dexscreener.com/solana/${pair.pairAddress}`,
    firstSeen: pair.pairCreatedAt ?? now,
    metrics: m,
    momentum: momentum(pair),
    soft: null,
  };
  const skipped = new Set<string>();

  // free_kill, cheap half: age / liquidity / mcap. Fail here and we never touch the RPC.
  if (cheapFreeFails(m)) {
    skipped.add('max_top_wallet').add('max_top_10');
    return finish(base, 'free_kill', skipped);
  }

  // free_kill, on-chain half: holder concentration (the pool and other program accounts excluded)
  const mintInfo = await deps.rpc.getMint(mint);
  if (!mintInfo) {
    log.warn('mint account not found or not a mint', { mint });
    return finish(base, 'free_kill', skipped);
  }
  const conc = await deps.rpc.concentration(mint, mintInfo.supply, pair.pairAddress);
  m.topWallet = conc.topWallet;
  m.top10 = conc.top10;
  m.mintRevoked = mintInfo.mintAuthority === null;
  m.freezeRevoked = mintInfo.freezeAuthority === null;
  if (deps.holdersViaGpa) m.holders = await deps.rpc.holderCount(mint, mintInfo.program);

  const pre = evaluateChain(m, null, 'trade_kill');
  if (pre.diedAt) {
    for (const k of ['mint_revoked', 'freeze_revoked', 'sell_routes', 'buy_impact_pct', 'sell_impact_pct']) skipped.add(k);
    return finish(base, 'trade_kill', skipped);
  }

  // chain_kill: authorities first (free), then a buy and a sell quote at ticket size
  if (!m.mintRevoked || !m.freezeRevoked) {
    for (const k of ['sell_routes', 'buy_impact_pct', 'sell_impact_pct']) skipped.add(k);
    return finish(base, 'chain_kill', skipped);
  }
  if (ticketLamports <= 0n) return null;
  const buy = await deps.jupiter.quote(SOL_MINT, mint, ticketLamports);
  if (!buy.ok) {
    skipped.add('sell_routes').add('sell_impact_pct');
    log.info('no buy route', { mint, reason: buy.detail });
    return finish(base, 'chain_kill', skipped);
  }
  m.buyImpactPct = Number.isFinite(buy.impactPct) ? buy.impactPct : null;
  const sell = await deps.jupiter.quote(mint, SOL_MINT, buy.outAmount);
  m.sellRoutes = sell.ok;
  m.sellImpactPct = sell.ok && Number.isFinite(sell.impactPct) ? sell.impactPct : null;
  if (!sell.ok && sell.reason === 'error') log.warn('sell quote error', { mint, detail: sell.detail });
  return finish(base, 'chain_kill', skipped);
}

/** Ticket size for quotes: 2% of the wallet, or the configured fallback when no wallet is set. */
export function ticketLamports(walletSol: number | null, fallbackSol: number | null): bigint {
  const sol = walletSol !== null && walletSol > 0 ? (walletSol * RAILS.maxTicketPct) / 100 : (fallbackSol ?? 0);
  return BigInt(Math.max(0, Math.floor(sol * 1e9)));
}
