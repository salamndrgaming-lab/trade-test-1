import { HARD, HARD_STEP, KILL_CHAIN, MAX_PRICE_IMPACT_PCT, SOFT, SOFT_KEYS, hardOp, type HardKey } from './thresholds.js';
import type { ThresholdsView } from './state.js';

export function thresholdsView(): ThresholdsView {
  return {
    hard: (Object.keys(HARD) as HardKey[]).map((key) => ({ key, op: hardOp(key), value: HARD[key], step: HARD_STEP[key] })),
    soft: SOFT_KEYS.map((key) => ({ key, op: SOFT[key].op, value: SOFT[key].value })),
    maxPriceImpactPct: MAX_PRICE_IMPACT_PCT,
    chain: [...KILL_CHAIN],
  };
}
