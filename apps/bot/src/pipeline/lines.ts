import type { AgentId, KillStep, TokenAnalysis } from '@coin/shared';

/** What the agents say about real pipeline results. Every line is ≤ 60 chars and states a fact. */
const pickBy = (seed: string, xs: string[]) => xs[[...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % xs.length]!;

export function crawlerSummary(newCount: number, rechecks: number): string {
  if (newCount === 0) return rechecks ? `No new tokens. Re-checking ${rechecks}.` : 'Feed is quiet. Watching.';
  return `Pulled ${newCount} new token${newCount === 1 ? '' : 's'} off the feed.`;
}

export function scanSummary(checked: number, dropped: number): string {
  return `${checked} checked, ${dropped} failed the numbers.`;
}

const FAIL_TEXT: Record<string, string> = {
  min_age_minutes: 'too young',
  min_liquidity_usd: 'liquidity too thin',
  min_mcap_usd: 'mcap too small',
  max_top_wallet: 'one wallet holds too much',
  max_top_10: 'top 10 hold too much',
  min_volume_h24: 'volume too low',
  min_trades_h24: 'too few trades',
  mint_revoked: 'mint authority still live',
  freeze_revoked: 'freeze authority still live',
  sell_routes: 'no sell route',
  buy_impact_pct: 'buy impact over 3%',
  sell_impact_pct: 'sell impact over 3%',
};

export function dropLine(t: TokenAnalysis): { agent: AgentId; text: string } {
  const step = t.diedAt as KillStep;
  const failed = t.checks.find((c) => c.step === step && c.pass === false);
  const why = failed ? (FAIL_TEXT[failed.key] ?? failed.key) : step;
  const agent: AgentId = step === 'chain_kill' ? 'vet' : 'scan';
  return { agent, text: `$${t.symbol}: ${why}. Dropped.`.slice(0, 60) };
}

export function survivorLines(t: TokenAnalysis): { vet: string; social: string } {
  return {
    vet: pickBy(t.mint, [`$${t.symbol} clean on-chain. Sells route.`, `Chain checks pass on $${t.symbol}.`]).slice(0, 60),
    social: `$${t.symbol} needs model scores. Phase 3.`.slice(0, 60),
  };
}
