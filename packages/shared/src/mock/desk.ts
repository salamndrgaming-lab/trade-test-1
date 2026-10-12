import { AGENTS, AGENT_IDS, type AgentId } from '../agents.js';
import { evaluateChain } from '../chain.js';
import type { AgentEvent, RiskAction } from '../events.js';
import type {
  AgentCard, AiProvider, Candle, EquityPoint, Position, RailsState, SoftScores, StateSnapshot, TokenAnalysis, TokenMetrics, TradeMarker,
} from '../state.js';
import { HARD, SOFT, type KillStep, type SoftKey } from '../thresholds.js';
import { thresholdsView } from '../view.js';
import { LINES, fill } from './lines.js';
import { between, fakeBase58, fakeTicker, mulberry32, pick, type Rng } from './rng.js';

/**
 * A fake trading desk. Same StateSnapshot shape as the real bot, driven by a seeded RNG
 * and wall-clock time. Time is compressed so something happens every few seconds.
 */

const STEP_MS = 1400;
const CANDLE_MS = 15_000;
const EQUITY_MS = 15_000;
const SOL_USD = 162;
const NEURON_LIMIT = 10_000;
const MAX_EVENTS = 60;
/** mock compresses the one-hour pause after two losses */
const MOCK_PAUSE_MS = 90_000;

type Outcome = KillStep | 'survive';

interface Job { at: number; run: () => void }

export interface MockDeskOptions { seed?: number; now?: number; mode?: 'shadow' | 'live' }

/** Present in any bundle that includes the mock desk. CI fails a production build that contains it. */
export const MOCK_MARKER = '__coin_trader_mock_desk__';

export class MockDesk {
  static readonly marker = MOCK_MARKER;
  private rng: Rng;
  private now: number;
  private seq = 0;
  private evId = 0;
  private jobs: Job[] = [];
  private events: AgentEvent[] = [];
  private tokenCount = 0;
  private lastPriceTick = 0;

  private readonly startedAt: number;
  private readonly mode: 'shadow' | 'live';
  private readonly address: string;
  private sol = 12.5;
  private dayStartSol = 12.5;
  private neurons: number;
  private calls: Record<AiProvider, number> = { workers_ai: 0, groq: 0, gemini: 0, rules_only: 0 };
  private budgetWarned = false;

  private agents: Record<AgentId, AgentCard>;
  private scanned = 0;
  private dropped: Record<KillStep, number> = { free_kill: 0, trade_kill: 0, chain_kill: 0, soft_kill: 0, pick: 0 };
  private current: TokenAnalysis | null = null;
  private shortlist: TokenAnalysis[] = [];
  private recent: TokenAnalysis[] = [];
  private picksToday = 0;
  private fillsToday = 0;

  private position: Position | null = null;
  private positionExitAt = 0;
  private pickChart: StateSnapshot['pickChart'] = null;
  private equity: EquityPoint[] = [];
  private pendingVolume = 0;

  private rails: RailsState = {
    maxTicketPct: 2, dailyLossCapPct: 10, maxOpenPositions: 1, stopLossPct: -25, takeProfitPct: 50,
    maxPriceImpactPct: 3, lossStreak: 0, pausedUntil: null, dailyLossHit: false, killSwitch: false,
    buysAllowed: true, blockReason: null,
  };

  constructor(opts: MockDeskOptions = {}) {
    this.rng = mulberry32(opts.seed ?? 0xc01d);
    this.now = opts.now ?? Date.now();
    this.mode = opts.mode ?? 'shadow';
    this.startedAt = this.now - 3 * 86_400_000 - 5 * 3_600_000;
    this.address = fakeBase58(this.rng, 44);
    this.neurons = Math.round(between(this.rng, 2600, 3600));
    this.agents = Object.fromEntries(AGENT_IDS.map((id) => [id, this.blankCard(id)])) as Record<AgentId, AgentCard>;
    this.seedHistory();
    this.schedule(600, () => this.newToken());
  }

  // ── public API ────────────────────────────────────────────────

  /** Advance the simulation to `now` and return a fresh snapshot. */
  tick(now: number = Date.now()): StateSnapshot {
    this.advance(now);
    return this.snapshot();
  }

  setKillSwitch(on: boolean, now: number = Date.now()): StateSnapshot {
    this.advance(now);
    if (on && !this.rails.killSwitch) {
      this.rails.killSwitch = true;
      this.emit({ agent: 'risk', kind: 'risk', action: 'kill_switch', detail: 'Kill switch engaged' });
      this.say('risk', pick(this.rng, LINES.risk.kill!), {});
      if (this.position) this.closePosition('kill');
    } else if (!on && this.rails.killSwitch) {
      this.rails.killSwitch = false;
      this.emit({ agent: 'risk', kind: 'risk', action: 'kill_switch_off', detail: 'Kill switch released' });
      this.say('risk', pick(this.rng, LINES.risk.unkill!), {});
    }
    this.updateRails();
    return this.snapshot();
  }

  // ── clock ─────────────────────────────────────────────────────

  private advance(to: number) {
    // never simulate more than 2 minutes in one go (tab was asleep)
    if (to - this.now > 120_000) this.fastForward(to - 120_000);
    while (true) {
      this.jobs.sort((a, b) => a.at - b.at);
      const next = this.jobs[0];
      if (!next || next.at > to) break;
      this.jobs.shift();
      this.stepClock(next.at);
      next.run();
    }
    this.stepClock(to);
  }

  private fastForward(to: number) {
    const shift = to - this.now;
    this.now = to;
    this.lastPriceTick = to;
    for (const j of this.jobs) j.at += shift;
  }

  private stepClock(to: number) {
    while (this.lastPriceTick + 1000 <= to) {
      this.lastPriceTick += 1000;
      this.now = this.lastPriceTick;
      this.secondTick();
    }
    this.now = Math.max(this.now, to);
  }

  private schedule(delay: number, run: () => void) {
    this.jobs.push({ at: this.now + delay, run });
  }

  // ── per-second updates ────────────────────────────────────────

  private secondTick() {
    const t = this.now;
    if (this.position && this.pickChart) {
      const p = this.position;
      const drift = 0.002;
      const shock = (this.rng() - 0.5) * 2 * 0.045;
      p.markPriceUsd = Math.max(p.markPriceUsd * (1 + drift + shock), p.entryPriceUsd * 0.05);
      p.pnlPct = (p.markPriceUsd / p.entryPriceUsd - 1) * 100;
      p.pnlUsd = (p.sizeUsd * p.pnlPct) / 100;
      this.pushPrice(p.markPriceUsd, between(this.rng, 200, 2400));
      if (p.pnlPct <= this.rails.stopLossPct) this.closePosition('sl');
      else if (p.pnlPct >= this.rails.takeProfitPct) this.closePosition('tp');
      else if (t >= this.positionExitAt) this.closePosition('time');
    } else if (this.pickChart) {
      // keep the last pick's chart alive with a gentle drift
      const last = this.pickChart.candles.at(-1);
      if (last) this.pushPrice(last.close * (1 + (this.rng() - 0.5) * 0.02), between(this.rng, 50, 600));
    }

    const lastEq = this.equity.at(-1);
    if (!lastEq || t - lastEq.time * 1000 >= EQUITY_MS) {
      const usd = this.equityUsd();
      this.equity.push({ time: Math.floor(t / 1000), usd, volumeUsd: this.pendingVolume, up: !lastEq || usd >= lastEq.usd });
      this.pendingVolume = 0;
      if (this.equity.length > 240) this.equity.shift();
    }

    if (this.rails.pausedUntil && t >= this.rails.pausedUntil) {
      this.rails.pausedUntil = null;
      this.rails.lossStreak = 0;
    }
    this.updateRails();
    this.updateCards();
  }

  private pushPrice(price: number, vol: number) {
    if (!this.pickChart) return;
    const c = this.pickChart.candles;
    const bucket = Math.floor(this.now / CANDLE_MS) * (CANDLE_MS / 1000);
    const last = c.at(-1);
    if (last && last.time === bucket) {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.volume += vol;
    } else {
      c.push({ time: bucket, open: last?.close ?? price, high: Math.max(price, last?.close ?? price), low: Math.min(price, last?.close ?? price), close: price, volume: vol });
      if (c.length > 120) c.shift();
    }
  }

  // ── token flow ───────────────────────────────────────────────

  private newToken() {
    this.tokenCount++;
    const outcome = this.rollOutcome();
    const token = this.makeToken(outcome);
    this.current = token;
    this.scanned++;
    this.emit({ agent: 'crawler', kind: 'token_found', mint: token.mint, symbol: token.symbol });
    this.say('crawler', pick(this.rng, LINES.crawler.found!), { $SYM: '$' + token.symbol });
    this.setStatus('crawler', 'working');

    this.schedule(STEP_MS, () => this.handoff('crawler', 'scan', token));
    this.schedule(STEP_MS * 2, () => this.scanStep(token));
  }

  private rollOutcome(): Outcome {
    if (this.tokenCount === 3) return 'survive'; // show a pick early in the demo
    const r = this.rng();
    if (r < 0.52) return 'free_kill';
    if (r < 0.74) return 'trade_kill';
    if (r < 0.87) return 'chain_kill';
    if (r < 0.95) return 'soft_kill';
    return 'survive';
  }

  private scanStep(token: TokenAnalysis) {
    this.setStatus('scan', 'working');
    const { metrics } = token;
    token.momentum = clamp01(0.35 + metrics.change5m / 90 + metrics.change1h / 450 + (this.rng() - 0.5) * 0.2);
    const res = evaluateChain(metrics, null, 'trade_kill');
    token.checks = res.checks;
    for (const step of ['free_kill', 'trade_kill'] as const) {
      const ok = res.diedAt !== step;
      this.emit({ agent: 'scan', kind: 'check', mint: token.mint, step, pass: ok });
      if (!ok) return this.drop('scan', token, step);
    }
    this.say('scan', pick(this.rng, LINES.scan.pass!), { $SYM: '$' + token.symbol, '{M}': token.momentum.toFixed(2) });
    this.schedule(STEP_MS * 0.5, () => this.handoff('scan', 'vet', token));
    this.schedule(STEP_MS * 1.5, () => this.vetStep(token));
  }

  private vetStep(token: TokenAnalysis) {
    this.setStatus('vet', 'working');
    const res = evaluateChain(token.metrics, null, 'chain_kill');
    token.checks = res.checks;
    const ok = res.diedAt === null;
    this.emit({ agent: 'vet', kind: 'check', mint: token.mint, step: 'chain_kill', pass: ok });
    if (!ok) return this.drop('vet', token, 'chain_kill');
    this.say('vet', pick(this.rng, LINES.vet.pass!), { $SYM: '$' + token.symbol });
    this.schedule(STEP_MS * 0.5, () => this.handoff('vet', 'social', token));
    this.schedule(STEP_MS * 1.5, () => this.socialStep(token));
  }

  private socialStep(token: TokenAnalysis) {
    this.setStatus('social', 'working');
    this.spendNeurons(between(this.rng, 18, 34));
    const res = evaluateChain(token.metrics, token.soft, 'soft_kill');
    token.checks = res.checks;
    const ok = res.diedAt === null;
    this.emit({ agent: 'social', kind: 'check', mint: token.mint, step: 'soft_kill', pass: ok });
    if (!ok) return this.drop('social', token, 'soft_kill');
    this.say('social', pick(this.rng, LINES.social.pass!), { $SYM: '$' + token.symbol });
    token.verdict = 'shortlisted';
    token.verdictReason = 'Survived the kill chain';
    this.shortlist = [token, ...this.shortlist.filter((t) => t.mint !== token.mint)].slice(0, 3);
    this.schedule(STEP_MS * 0.5, () => this.handoff('social', 'chief', token));
    this.schedule(STEP_MS * 1.5, () => this.chiefStep(token));
  }

  private chiefStep(token: TokenAnalysis) {
    this.setStatus('chief', 'working');
    this.updateRails();
    if (!this.rails.buysAllowed || this.position) {
      token.verdict = 'passed_over';
      token.verdictReason = this.position ? 'Already holding a position' : (this.rails.blockReason ?? 'Buys blocked');
      this.say('chief', pick(this.rng, LINES.chief.pass!), { $SYM: '$' + token.symbol });
      return this.finish(token, 1200);
    }
    this.spendNeurons(between(this.rng, 45, 80));
    // Chief picks from the shortlist (top 3 by momentum); the newest survivor is usually it
    const best = [...this.shortlist].sort((a, b) => (b.momentum ?? 0) - (a.momentum ?? 0))[0] ?? token;
    const chosen = best.mint === token.mint || this.rng() < 0.7 ? token : best;
    chosen.verdict = 'picked';
    chosen.verdictReason = 'Chief pick';
    for (const t of this.shortlist) if (t !== chosen && t.verdict === 'shortlisted') { t.verdict = 'passed_over'; t.verdictReason = 'Chief chose ' + chosen.symbol; }
    this.picksToday++;
    this.emit({ agent: 'chief', kind: 'pick', mint: chosen.mint, symbol: chosen.symbol });
    this.say('chief', pick(this.rng, LINES.chief.pick!), { $SYM: '$' + chosen.symbol });
    this.startChart(chosen);

    const ticketSol = round(this.sol * (this.rails.maxTicketPct / 100) * between(this.rng, 0.7, 1), 3);
    this.schedule(STEP_MS * 0.5, () => this.handoff('chief', 'size', chosen));
    this.schedule(STEP_MS * 1.5, () => {
      this.setStatus('size', 'working');
      this.agents.size.metric = { label: 'Ticket', value: ticketSol, display: `${ticketSol} SOL`, bar: ticketSol / (this.sol * 0.02) };
      this.say('size', pick(this.rng, LINES.size.size!), { $SYM: '$' + chosen.symbol, '{SOL}': String(ticketSol) });
    });
    this.schedule(STEP_MS * 2, () => this.handoff('size', 'fills', chosen));
    this.schedule(STEP_MS * 3, () => this.openPosition(chosen, ticketSol));
  }

  private openPosition(token: TokenAnalysis, sizeSol: number) {
    this.setStatus('fills', 'working');
    const price = token.metrics.priceUsd;
    const impact = token.metrics.buyImpactPct ?? 1;
    this.position = {
      mint: token.mint, symbol: token.symbol, openedAt: this.now, entryPriceUsd: price, sizeSol, sizeUsd: sizeSol * SOL_USD,
      markPriceUsd: price, pnlPct: 0, pnlUsd: 0, stopLossPct: this.rails.stopLossPct, takeProfitPct: this.rails.takeProfitPct,
      shadow: this.mode === 'shadow',
    };
    this.positionExitAt = this.now + between(this.rng, 45_000, 95_000);
    this.fillsToday++;
    this.pendingVolume += sizeSol * SOL_USD;
    this.marker('buy', price);
    this.emit({ agent: 'fills', kind: 'fill', mint: token.mint, symbol: token.symbol, side: 'buy', sol: sizeSol, usd: sizeSol * SOL_USD, shadow: this.mode === 'shadow', sig: null });
    this.say('fills', pick(this.rng, LINES.fills.buy!), { $SYM: '$' + token.symbol, '{I}': impact.toFixed(2) });
    this.agents.fills.metric = { label: 'Impact', value: impact, display: `${impact.toFixed(2)}%`, bar: impact / 3 };
    this.schedule(STEP_MS, () => {
      this.handoff('fills', 'risk', token);
      this.say('risk', pick(this.rng, LINES.risk.watch!), { $SYM: '$' + token.symbol });
    });
    this.finish(token, STEP_MS * 2);
  }

  private closePosition(why: 'sl' | 'tp' | 'time' | 'kill') {
    const p = this.position;
    if (!p) return;
    this.position = null;
    const outSol = p.sizeSol * (1 + p.pnlPct / 100) * 0.997; // fees
    const pnlSol = outSol - p.sizeSol;
    this.sol += pnlSol;
    this.pendingVolume += outSol * SOL_USD;
    this.fillsToday++;
    this.marker('sell', p.markPriceUsd);
    const action: RiskAction | null = why === 'sl' ? 'stop_loss' : why === 'tp' ? 'take_profit' : null;
    if (action) {
      this.emit({ agent: 'risk', kind: 'risk', action, detail: `${p.symbol} ${p.pnlPct.toFixed(1)}%` });
      this.say('risk', pick(this.rng, (why === 'sl' ? LINES.risk.sl : LINES.risk.tp)!), { $SYM: '$' + p.symbol });
    } else if (why === 'time') {
      this.say('risk', pick(this.rng, LINES.risk.time!), { $SYM: '$' + p.symbol });
    }
    this.emit({ agent: 'fills', kind: 'fill', mint: p.mint, symbol: p.symbol, side: 'sell', sol: round(outSol, 4), usd: outSol * SOL_USD, shadow: p.shadow, sig: null });
    this.say('fills', pick(this.rng, LINES.fills.sell!), { $SYM: '$' + p.symbol, '{P}': `${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%` });

    if (pnlSol < 0) {
      this.rails.lossStreak++;
      if (this.rails.lossStreak >= 2 && !this.rails.pausedUntil) {
        this.rails.pausedUntil = this.now + MOCK_PAUSE_MS;
        this.emit({ agent: 'risk', kind: 'risk', action: 'pause', detail: 'Two losses in a row' });
        this.say('risk', LINES.risk.pause![0]!, {});
      }
    } else {
      this.rails.lossStreak = 0;
    }
    if (!this.rails.dailyLossHit && this.sol <= this.dayStartSol * (1 - this.rails.dailyLossCapPct / 100)) {
      this.rails.dailyLossHit = true;
      this.emit({ agent: 'risk', kind: 'risk', action: 'loss_cap', detail: 'Daily loss cap hit' });
    }
    this.updateRails();
  }

  private drop(agent: AgentId, token: TokenAnalysis, step: KillStep) {
    this.dropped[step]++;
    token.diedAt = step;
    token.verdict = 'dropped';
    const failed = token.checks.filter((c) => c.step === step && c.pass === false).map((c) => c.key);
    token.verdictReason = `${step}: ${failed.join(', ')}`;
    this.emit({ agent, kind: 'drop', mint: token.mint, symbol: token.symbol, step, reason: token.verdictReason });
    const pool = agent === 'scan' ? LINES.scan.drop : agent === 'vet' ? LINES.vet.drop : LINES.social.drop;
    this.say(agent, pick(this.rng, pool!), { $SYM: '$' + token.symbol });
    this.finish(token, 1500);
  }

  private finish(token: TokenAnalysis, delay: number) {
    this.recent = [token, ...this.recent.filter((t) => t.mint !== token.mint)].slice(0, 20);
    this.schedule(delay, () => {
      if (this.current?.mint === token.mint) this.current = null;
      for (const id of AGENT_IDS) if (id !== 'risk' || !this.position) this.setStatus(id, 'idle');
      this.schedule(between(this.rng, 400, 1400), () => this.newToken());
    });
  }

  private handoff(from: AgentId, to: AgentId, token: TokenAnalysis) {
    this.emit({ agent: from, kind: 'handoff', to, mint: token.mint, symbol: token.symbol });
    this.setStatus(from, 'idle');
    this.setStatus(to, 'working');
  }

  // ── token synthesis ──────────────────────────────────────────

  private makeToken(outcome: Outcome): TokenAnalysis {
    const r = this.rng;
    const symbol = fakeTicker(r);
    const good: TokenMetrics = {
      ageMinutes: Math.round(between(r, 18, 240)),
      liquidityUsd: Math.round(between(r, 14_000, 90_000)),
      volumeH24: Math.round(between(r, 45_000, 900_000)),
      mcapUsd: Math.round(between(r, 70_000, 2_500_000)),
      tradesH24: Math.round(between(r, 180, 6000)),
      priceUsd: between(r, 0.00002, 0.004),
      change5m: between(r, -8, 25),
      change1h: between(r, -20, 120),
      holders: Math.round(between(r, 220, 4000)),
      topWallet: between(r, 0.012, 0.045),
      top10: between(r, 0.18, 0.52),
      mintRevoked: true,
      freezeRevoked: true,
      buyImpactPct: between(r, 0.3, 2.4),
      sellImpactPct: between(r, 0.4, 2.7),
      sellRoutes: true,
    };
    const soft = this.goodSoft();

    switch (outcome) {
      case 'free_kill': {
        const k = pick(r, ['age', 'liq', 'mcap', 'top', 'top10'] as const);
        if (k === 'age') good.ageMinutes = Math.round(between(r, 1, HARD.min_age_minutes - 1));
        if (k === 'liq') good.liquidityUsd = Math.round(between(r, 900, HARD.min_liquidity_usd - 500));
        if (k === 'mcap') good.mcapUsd = Math.round(between(r, 8_000, HARD.min_mcap_usd - 1000));
        if (k === 'top') good.topWallet = between(r, 0.06, 0.3);
        if (k === 'top10') good.top10 = between(r, 0.62, 0.95);
        if (r() < 0.4) good.ageMinutes = Math.round(between(r, 1, 12)); // often more than one fails
        break;
      }
      case 'trade_kill':
        if (r() < 0.5) good.volumeH24 = Math.round(between(r, 3_000, HARD.min_volume_h24 - 1000));
        else good.tradesH24 = Math.round(between(r, 12, HARD.min_trades_h24 - 5));
        break;
      case 'chain_kill': {
        const k = pick(r, ['mint', 'freeze', 'route', 'impact'] as const);
        if (k === 'mint') good.mintRevoked = false;
        if (k === 'freeze') good.freezeRevoked = false;
        if (k === 'route') { good.sellRoutes = false; good.sellImpactPct = null; }
        if (k === 'impact') good.sellImpactPct = between(r, 3.4, 18);
        break;
      }
      case 'soft_kill': {
        const keys = Object.keys(SOFT) as SoftKey[];
        const k = pick(r, keys);
        const { op, value } = SOFT[k];
        soft[k] = op === 'max' ? between(r, value + 0.05, 0.98) : between(r, 0.05, value - 0.05);
        break;
      }
    }

    const mint = fakeBase58(r, 44);
    const pairAddress = fakeBase58(r, 44);
    return {
      mint, symbol, name: symbol.charAt(0) + symbol.slice(1).toLowerCase() + ' Coin', pairAddress,
      dexUrl: `https://dexscreener.com/solana/${pairAddress}`,
      firstSeen: this.now - good.ageMinutes * 60_000,
      metrics: good,
      momentum: null,
      soft: { ...soft, cachedUntil: this.now + 15 * 60_000 },
      checks: evaluateChain(good, null, 'free_kill').checks.map((c) => ({ ...c, pass: null })),
      diedAt: null,
      verdict: 'pending',
      verdictReason: '',
    };
  }

  private goodSoft(): Record<SoftKey, number> {
    const r = this.rng;
    const out = {} as Record<SoftKey, number>;
    for (const k of Object.keys(SOFT) as SoftKey[]) {
      const { op, value } = SOFT[k];
      out[k] = op === 'max' ? between(r, 0.05, value - 0.05) : between(r, value + 0.03, 0.97);
    }
    return out;
  }

  // ── chart / equity ───────────────────────────────────────────

  private startChart(token: TokenAnalysis) {
    const candles: Candle[] = [];
    const end = Math.floor(this.now / CANDLE_MS) * (CANDLE_MS / 1000);
    const n = 48;
    // walk backwards from the current price so the chart ends where the token is now
    let price = token.metrics.priceUsd;
    const closes: number[] = [];
    for (let i = 0; i < n; i++) {
      closes.unshift(price);
      price = price / (1 + 0.012 + (this.rng() - 0.5) * 0.09);
    }
    let prev = closes[0]! * 0.97;
    closes.forEach((close, i) => {
      const hi = Math.max(prev, close) * (1 + this.rng() * 0.03);
      const lo = Math.min(prev, close) * (1 - this.rng() * 0.03);
      candles.push({ time: end - (n - 1 - i) * (CANDLE_MS / 1000), open: prev, high: hi, low: lo, close, volume: between(this.rng, 300, 5000) });
      prev = close;
    });
    this.pickChart = { mint: token.mint, symbol: token.symbol, candles, markers: [] };
  }

  private marker(side: 'buy' | 'sell', price: number) {
    if (!this.pickChart) return;
    const time = Math.floor(this.now / CANDLE_MS) * (CANDLE_MS / 1000);
    const m: TradeMarker = { time, side, price, shadow: this.mode === 'shadow' };
    this.pickChart.markers.push(m);
  }

  private equityUsd() {
    const open = this.position ? this.position.pnlUsd : 0;
    return round(this.sol * SOL_USD + open, 2);
  }

  private seedHistory() {
    let usd = this.sol * SOL_USD * 0.93;
    const n = 120;
    for (let i = n; i > 0; i--) {
      const traded = this.rng() < 0.18;
      const delta = traded ? (this.rng() - 0.42) * 22 : (this.rng() - 0.5) * 1.5;
      const prev = usd;
      usd = Math.max(500, usd + delta);
      this.equity.push({ time: Math.floor((this.now - i * EQUITY_MS) / 1000), usd: round(usd, 2), volumeUsd: traded ? between(this.rng, 30, 90) : 0, up: usd >= prev });
    }
    // make the series end at the real balance
    const shift = this.sol * SOL_USD - usd;
    for (const p of this.equity) p.usd = round(p.usd + shift, 2);
    this.lastPriceTick = this.now;
  }

  // ── cards / rails / ai ───────────────────────────────────────

  private blankCard(id: AgentId): AgentCard {
    const m = AGENTS[id];
    return { id, name: m.name, role: m.role, status: 'idle', metric: { label: '', value: 0, display: '—', bar: 0 }, quote: 'Clocking in.', quoteAt: this.now };
  }

  private setStatus(id: AgentId, s: AgentCard['status']) {
    this.agents[id].status = s;
  }

  private say(agent: AgentId, line: string, vars: Record<string, string>) {
    const text = fill(line, vars);
    this.agents[agent].quote = text;
    this.agents[agent].quoteAt = this.now;
    this.emit({ agent, kind: 'say', text });
  }

  private emit(e: DistributiveOmit<AgentEvent, 'id' | 't'>) {
    this.events.push({ ...e, id: `e${++this.evId}`, t: this.now } as AgentEvent);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private spendNeurons(n: number) {
    this.neurons = Math.round(this.neurons + n);
    this.calls.workers_ai++;
    const pct = this.neurons / NEURON_LIMIT;
    if (pct >= 0.9 && !this.budgetWarned) {
      this.budgetWarned = true;
      this.emit({ agent: 'chief', kind: 'ai_budget', provider: 'groq', pct });
    }
  }

  private provider(): AiProvider {
    return this.neurons >= NEURON_LIMIT * 0.9 ? 'groq' : 'workers_ai';
  }

  private updateRails() {
    const r = this.rails;
    let reason: string | null = null;
    if (r.killSwitch) reason = 'Kill switch on';
    else if (r.dailyLossHit) reason = 'Daily loss cap hit';
    else if (r.pausedUntil && r.pausedUntil > this.now) reason = 'Paused after two losses';
    r.buysAllowed = reason === null;
    r.blockReason = reason;
  }

  private updateCards() {
    const a = this.agents;
    const passRate = this.scanned ? (this.scanned - this.dropped.free_kill - this.dropped.trade_kill - this.dropped.chain_kill) / this.scanned : 0;
    const lastSoft = this.recent.find((t) => t.soft && (t.diedAt === 'soft_kill' || t.diedAt === null))?.soft;
    a.crawler.metric = { label: 'Scanned', value: this.scanned, display: `${this.scanned} today`, bar: Math.min(1, this.scanned / 400) };
    const mom = this.current?.momentum ?? this.recent.find((t) => t.momentum !== null)?.momentum ?? 0;
    a.scan.metric = { label: 'Momentum', value: mom, display: mom.toFixed(2), bar: mom };
    a.vet.metric = { label: 'Chain pass', value: passRate, display: `${Math.round(passRate * 100)}%`, bar: passRate };
    const own = lastSoft?.account_is_the_project ?? 0;
    a.social.metric = { label: 'Is project', value: own, display: own.toFixed(2), bar: own };
    a.chief.metric = { label: 'Picks', value: this.picksToday, display: `${this.picksToday} today`, bar: Math.min(1, this.picksToday / 10) };
    if (a.size.metric.display === '—') a.size.metric = { label: 'Ticket', value: 0, display: '0 SOL', bar: 0 };
    if (a.fills.metric.display === '—') a.fills.metric = { label: 'Impact', value: 0, display: '—', bar: 0 };
    const lossUsedPct = Math.max(0, ((this.dayStartSol - this.sol) / this.dayStartSol) * 100);
    a.risk.metric = { label: 'Loss cap used', value: lossUsedPct, display: `${lossUsedPct.toFixed(1)}%/${this.rails.dailyLossCapPct}%`, bar: lossUsedPct / this.rails.dailyLossCapPct };
    a.risk.status = this.rails.killSwitch ? 'blocked' : this.rails.pausedUntil ? 'paused' : this.position ? 'working' : a.risk.status;
  }

  private snapshot(): StateSnapshot {
    this.seq++;
    const usd = this.equityUsd();
    const dayStartUsd = this.dayStartSol * SOL_USD;
    return structuredClone({
      v: 1,
      seq: this.seq,
      serverTime: this.now,
      startedAt: this.startedAt,
      mode: this.mode,
      source: 'mock',
      bot: { online: true, lastHeartbeat: this.now, tickMs: 1000 },
      ai: {
        provider: this.provider(),
        neuronsUsedToday: this.neurons,
        neuronsDailyLimit: NEURON_LIMIT,
        switchAt: 0.9,
        callsToday: { ...this.calls },
        newTradesBlocked: false,
      },
      wallet: {
        address: this.address,
        solBalance: round(this.sol + (this.position ? this.position.pnlUsd / SOL_USD : 0), 4),
        usdBalance: usd,
        pnlTodayUsd: round(usd - dayStartUsd, 2),
        pnlTodayPct: round(((usd - dayStartUsd) / dayStartUsd) * 100, 2),
      },
      agents: this.agents,
      pipeline: {
        scannedToday: this.scanned,
        droppedByStep: { ...this.dropped },
        current: this.current,
        shortlist: this.shortlist,
        recent: this.recent,
      },
      position: this.position,
      pickChart: this.pickChart,
      equity: { points: this.equity },
      rails: this.rails,
      thresholds: thresholdsView(),
      events: this.events,
    } satisfies StateSnapshot);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

