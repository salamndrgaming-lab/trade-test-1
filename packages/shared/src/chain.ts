import type { CheckResult, SoftScores, TokenMetrics } from './state.js';
import { HARD, HARD_STEP, KILL_CHAIN, MAX_PRICE_IMPACT_PCT, SOFT, SOFT_KEYS, hardOp, passes, type HardKey, type KillStep } from './thresholds.js';

/** metric each hard threshold reads */
const HARD_METRIC: Record<HardKey, keyof TokenMetrics> = {
  min_age_minutes: 'ageMinutes',
  min_liquidity_usd: 'liquidityUsd',
  min_mcap_usd: 'mcapUsd',
  max_top_wallet: 'topWallet',
  max_top_10: 'top10',
  min_volume_h24: 'volumeH24',
  min_trades_h24: 'tradesH24',
};

function hardCheck(key: HardKey, m: TokenMetrics): CheckResult {
  const raw = m[HARD_METRIC[key]];
  const value = typeof raw === 'number' ? raw : null;
  const op = hardOp(key);
  // missing data never passes a hard check
  return { key, step: HARD_STEP[key], value, limit: HARD[key], op, pass: value === null ? false : passes(op, value, HARD[key]) };
}

function boolCheck(key: string, value: boolean | null): CheckResult {
  return { key, step: 'chain_kill', value, limit: true, op: 'eq', pass: value === true };
}

function impactCheck(key: string, value: number | null): CheckResult {
  return { key, step: 'chain_kill', value, limit: MAX_PRICE_IMPACT_PCT, op: 'max', pass: value === null ? false : value <= MAX_PRICE_IMPACT_PCT };
}

/** All checks a token is judged on, grouped by step, in chain order. */
export function buildChecks(m: TokenMetrics, soft: SoftScores | null): Record<Exclude<KillStep, 'pick'>, CheckResult[]> {
  const hardKeys = Object.keys(HARD) as HardKey[];
  return {
    free_kill: hardKeys.filter((k) => HARD_STEP[k] === 'free_kill').map((k) => hardCheck(k, m)),
    trade_kill: hardKeys.filter((k) => HARD_STEP[k] === 'trade_kill').map((k) => hardCheck(k, m)),
    chain_kill: [
      boolCheck('mint_revoked', m.mintRevoked),
      boolCheck('freeze_revoked', m.freezeRevoked),
      boolCheck('sell_routes', m.sellRoutes),
      impactCheck('buy_impact_pct', m.buyImpactPct),
      impactCheck('sell_impact_pct', m.sellImpactPct),
    ],
    soft_kill: SOFT_KEYS.map((key) => {
      const { op, value: limit } = SOFT[key];
      const value = soft ? soft[key] : null;
      return { key, step: 'soft_kill', value, limit, op, pass: value === null ? false : passes(op, value, limit) };
    }),
  };
}

export interface ChainResult {
  checks: CheckResult[];
  /** first step with a failing check; null = survived to `pick` */
  diedAt: KillStep | null;
}

/**
 * Run the kill chain in fixed order: free_kill → trade_kill → chain_kill → soft_kill.
 * Every check inside the failing step is reported; later steps are marked not-reached (pass = null).
 * `upTo` stops evaluation early (e.g. before the model call for soft_kill).
 */
export function evaluateChain(m: TokenMetrics, soft: SoftScores | null, upTo: KillStep = 'soft_kill'): ChainResult {
  const groups = buildChecks(m, soft);
  const checks: CheckResult[] = [];
  let diedAt: KillStep | null = null;
  let stopped = false;
  for (const step of KILL_CHAIN) {
    if (step === 'pick') break;
    const group = groups[step];
    if (stopped) {
      checks.push(...group.map((c) => ({ ...c, pass: null })));
      continue;
    }
    checks.push(...group);
    if (group.some((c) => c.pass === false)) {
      diedAt = step;
      stopped = true;
    } else if (step === upTo) {
      stopped = true;
    }
  }
  return { checks, diedAt };
}
