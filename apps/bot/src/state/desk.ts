import {
  AGENTS, AGENT_IDS, thresholdsView,
  type AgentCard, type AgentEvent, type AgentId, type Candle, type EquityPoint, type StateSnapshot, type TokenAnalysis, type TradingMode,
} from '@coin/shared';
import { RAILS } from '../config.js';
import type { Repo } from '../db/db.js';

const MAX_EVENTS = 60;
const CANDLE_SEC = 60;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewEvent = DistributiveOmit<AgentEvent, 'id' | 't'>;

/**
 * Everything the dashboard sees, built from real pipeline output. Nothing here is invented:
 * a value we have not measured yet is shown as empty, not guessed.
 */
export class LiveDesk {
  private seq = 0;
  private evSeq: number;
  private events: AgentEvent[];
  private agents: Record<AgentId, AgentCard>;
  private current: TokenAnalysis | null = null;
  private focus: { mint: string; symbol: string; pairAddress: string; candles: Candle[] } | null = null;
  private lastTickAt = 0;
  private warnings: string[] = [];
  private wallet = { address: '', sol: null as number | null, solUsd: null as number | null };
  ticketSol = 0;
  /** live AI router state (phase 3); without it the desk reports rules-only */
  ai: (() => StateSnapshot['ai']) | null = null;

  constructor(
    private repo: Repo,
    private readonly mode: TradingMode,
    private readonly tickMs: number,
    private readonly startedAt: number = Number(repo.getSetting('started_at') ?? Date.now()),
    private readonly clock: () => number = Date.now,
  ) {
    if (!repo.getSetting('started_at')) repo.setSetting('started_at', String(this.startedAt));
    this.evSeq = repo.maxEventSeq();
    this.events = repo.recentEvents(MAX_EVENTS);
    const now = Date.now();
    this.agents = Object.fromEntries(
      AGENT_IDS.map((id) => [id, { id, name: AGENTS[id].name, role: AGENTS[id].role, status: 'idle', metric: { label: '', value: 0, display: '—', bar: 0 }, quote: '', quoteAt: now } satisfies AgentCard]),
    ) as Record<AgentId, AgentCard>;
    // restore the last thing each agent said
    for (const e of this.events) if (e.kind === 'say') this.setQuote(e.agent, e.text, e.t);
  }

  // ── writes from the pipeline ─────────────────────────────────

  emit(e: NewEvent, t = this.clock()): AgentEvent {
    const ev = { ...e, id: `e${++this.evSeq}`, t } as AgentEvent;
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.repo.saveEvent(ev);
    if (ev.kind === 'say') this.setQuote(ev.agent, ev.text, t);
    return ev;
  }

  say(agent: AgentId, text: string, t = this.clock()) {
    this.emit({ agent, kind: 'say', text: text.slice(0, 60) }, t);
  }

  setStatus(id: AgentId, s: AgentCard['status']) {
    this.agents[id].status = s;
  }

  setCurrent(t: TokenAnalysis | null) {
    this.current = t;
  }

  tickDone(t = this.clock(), warnings: string[] = []) {
    this.lastTickAt = t;
    this.warnings = warnings;
    for (const id of AGENT_IDS) if (this.agents[id].status === 'working') this.agents[id].status = 'idle';
  }

  setWallet(address: string, sol: number | null, solUsd: number | null) {
    this.wallet = { address, sol, solUsd };
  }

  /** The token on the big screen: the newest survivor. Candles come from our own price samples. */
  setFocus(t: { mint: string; symbol: string; pairAddress: string } | null) {
    if (!t) { this.focus = null; return; }
    if (this.focus?.mint !== t.mint) this.focus = { ...t, candles: [] };
  }

  get focusToken() {
    return this.focus;
  }

  addPriceSample(mint: string, price: number, volumeUsd: number, t = this.clock()) {
    if (!this.focus || this.focus.mint !== mint || !(price > 0)) return;
    const c = this.focus.candles;
    const bucket = Math.floor(t / 1000 / CANDLE_SEC) * CANDLE_SEC;
    const last = c.at(-1);
    if (last && last.time === bucket) {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.volume = Math.max(last.volume, volumeUsd);
    } else {
      c.push({ time: bucket, open: last?.close ?? price, high: Math.max(price, last?.close ?? price), low: Math.min(price, last?.close ?? price), close: price, volume: volumeUsd });
      if (c.length > 240) c.shift();
    }
  }

  private setQuote(id: AgentId, text: string, t: number) {
    this.agents[id].quote = text;
    this.agents[id].quoteAt = t;
  }

  // ── snapshot ─────────────────────────────────────────────────

  snapshot(now = this.clock()): StateSnapshot {
    this.seq++;
    const stats = this.repo.dayStats(now);
    const recent = this.repo.recentVerdicts(20);
    const shortlist = this.repo.survivors(3, now - 6 * 3_600_000);
    this.refreshCards(stats, recent);

    const sol = this.wallet.sol;
    const solUsd = this.wallet.solUsd;
    const usd = sol !== null && solUsd !== null ? sol * solUsd : 0;
    const dayStart = this.repo.firstBalanceOfDay(now);
    const pnlUsd = dayStart ? usd - dayStart.usd : 0;

    return {
      v: 1,
      seq: this.seq,
      serverTime: now,
      startedAt: this.startedAt,
      mode: this.mode,
      source: 'live',
      bot: { online: this.lastTickAt > 0 && now - this.lastTickAt < this.tickMs * 3, lastHeartbeat: this.lastTickAt, tickMs: this.tickMs, warnings: [...this.warnings] },
      ai: this.ai ? this.ai() : NO_AI,
      wallet: {
        address: this.wallet.address,
        solBalance: sol ?? 0,
        usdBalance: round(usd, 2),
        pnlTodayUsd: round(pnlUsd, 2),
        pnlTodayPct: dayStart && dayStart.usd > 0 ? round((pnlUsd / dayStart.usd) * 100, 2) : 0,
      },
      agents: structuredClone(this.agents),
      pipeline: { scannedToday: stats.scanned, droppedByStep: stats.dropped, current: this.current, shortlist, recent },
      position: null,
      pickChart: this.focus && this.focus.candles.length ? { mint: this.focus.mint, symbol: this.focus.symbol, candles: structuredClone(this.focus.candles), markers: [] } : null,
      equity: { points: this.equityPoints(now) },
      rails: {
        maxTicketPct: RAILS.maxTicketPct,
        dailyLossCapPct: RAILS.dailyLossCapPct,
        maxOpenPositions: RAILS.maxOpenPositions,
        stopLossPct: RAILS.stopLossPct,
        takeProfitPct: RAILS.takeProfitPct,
        maxPriceImpactPct: RAILS.maxPriceImpactPct,
        lossStreak: 0,
        pausedUntil: null,
        dailyLossHit: false,
        killSwitch: false,
        buysAllowed: false,
        blockReason: 'No trading until phase 4',
      },
      thresholds: thresholdsView(),
      events: [...this.events],
    };
  }

  private equityPoints(now: number): EquityPoint[] {
    const rows = this.repo.balances(now - 7 * 86_400_000);
    const out: EquityPoint[] = [];
    let prev: { t: number; usd: number } | null = null;
    for (const r of rows) {
      out.push({ time: Math.floor(r.t / 1000), usd: round(r.usd, 2), volumeUsd: prev ? round(this.repo.tradeVolumeBetween(prev.t, r.t), 2) : 0, up: !prev || r.usd >= prev.usd });
      prev = r;
    }
    return out;
  }

  private refreshCards(stats: { scanned: number; dropped: Record<string, number> }, recent: TokenAnalysis[]) {
    const a = this.agents;
    const reachedChain = recent.filter((t) => t.checks.some((c) => c.step === 'chain_kill' && c.pass !== null));
    const passedChain = reachedChain.filter((t) => !t.diedAt);
    const mom = this.current?.momentum ?? recent.find((t) => t.momentum !== null)?.momentum ?? null;
    const perMin = Math.min(1, stats.scanned / 400);
    a.crawler.metric = { label: 'Scanned today', value: stats.scanned, display: `${stats.scanned}`, bar: perMin };
    a.scan.metric = mom === null ? { label: 'Momentum', value: 0, display: '—', bar: 0 } : { label: 'Momentum', value: mom, display: mom.toFixed(2), bar: mom };
    const rate = reachedChain.length ? passedChain.length / reachedChain.length : null;
    a.vet.metric = rate === null ? { label: 'Chain pass', value: 0, display: '—', bar: 0 } : { label: 'Chain pass (recent)', value: rate, display: `${Math.round(rate * 100)}%`, bar: rate };
    const scored = recent.find((t) => t.soft);
    const own = scored?.soft?.account_is_the_project ?? null;
    a.social.metric = own === null ? { label: 'Is project', value: 0, display: '—', bar: 0 } : { label: `Is project ($${scored!.symbol})`, value: own, display: own.toFixed(2), bar: own };
    const picks = this.repo.picksToday(this.clock());
    a.chief.metric = { label: 'Picks today', value: picks, display: `${picks}`, bar: Math.min(1, picks / 10) };
    const tk = this.ticketSol;
    a.size.metric = { label: 'Quote ticket', value: tk, display: `${tk.toFixed(3)} SOL`, bar: tk > 0 ? 1 : 0 };
    a.fills.metric = { label: 'Fills today', value: 0, display: '0', bar: 0 };
    a.risk.metric = { label: 'Loss cap used', value: 0, display: `0%/${RAILS.dailyLossCapPct}%`, bar: 0 };
  }
}

const NO_AI: StateSnapshot['ai'] = {
  provider: 'rules_only',
  neuronsUsedToday: 0,
  neuronsDailyLimit: 10_000,
  switchAt: 0.9,
  callsToday: { workers_ai: 0, groq: 0, gemini: 0, rules_only: 0 },
  newTradesBlocked: true,
};

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
