import type { AgentId } from './agents.js';
import type { AgentEvent } from './events.js';
import type { KillStep, SoftKey } from './thresholds.js';

export type TradingMode = 'shadow' | 'live';
export type AiProvider = 'workers_ai' | 'groq' | 'gemini' | 'rules_only';

/** GET /state — the only thing the dashboard reads. Never contains secrets. */
export interface StateSnapshot {
  v: 1;
  seq: number;
  serverTime: number;
  startedAt: number;
  mode: TradingMode;
  source: 'mock' | 'live';
  bot: { online: boolean; lastHeartbeat: number; tickMs: number };

  ai: {
    provider: AiProvider;
    neuronsUsedToday: number;
    neuronsDailyLimit: number;
    switchAt: number;
    callsToday: Record<AiProvider, number>;
    newTradesBlocked: boolean;
  };

  wallet: {
    /** public key only */
    address: string;
    solBalance: number;
    usdBalance: number;
    pnlTodayUsd: number;
    pnlTodayPct: number;
  };

  agents: Record<AgentId, AgentCard>;

  pipeline: {
    scannedToday: number;
    droppedByStep: Record<KillStep, number>;
    current: TokenAnalysis | null;
    shortlist: TokenAnalysis[];
    recent: TokenAnalysis[];
  };

  position: Position | null;
  pickChart: { mint: string; symbol: string; candles: Candle[]; markers: TradeMarker[] } | null;
  equity: { points: EquityPoint[] };

  rails: RailsState;
  thresholds: ThresholdsView;
  events: AgentEvent[];
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'paused';

export interface AgentCard {
  id: AgentId;
  name: string;
  role: string;
  status: AgentStatus;
  metric: { label: string; value: number; display: string; bar: number };
  /** ≤ 60 chars */
  quote: string;
  quoteAt: number;
}

export interface TokenMetrics {
  ageMinutes: number;
  liquidityUsd: number;
  volumeH24: number;
  mcapUsd: number;
  tradesH24: number;
  priceUsd: number;
  change5m: number;
  change1h: number;
  holders: number | null;
  topWallet: number | null;
  top10: number | null;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  buyImpactPct: number | null;
  sellImpactPct: number | null;
  sellRoutes: boolean | null;
}

export type Verdict = 'pending' | 'dropped' | 'shortlisted' | 'picked' | 'passed_over';

export interface TokenAnalysis {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexUrl: string;
  firstSeen: number;
  metrics: TokenMetrics;
  momentum: number | null;
  soft: SoftScores | null;
  checks: CheckResult[];
  diedAt: KillStep | null;
  verdict: Verdict;
  verdictReason: string;
}

export type SoftScores = Record<SoftKey, number> & { cachedUntil: number };

export interface CheckResult {
  key: string;
  step: KillStep;
  value: number | boolean | null;
  limit: number | boolean;
  op: 'min' | 'max' | 'eq';
  /** null = not reached (token died earlier) */
  pass: boolean | null;
}

export interface Position {
  mint: string;
  symbol: string;
  openedAt: number;
  entryPriceUsd: number;
  sizeSol: number;
  sizeUsd: number;
  markPriceUsd: number;
  pnlPct: number;
  pnlUsd: number;
  stopLossPct: number;
  takeProfitPct: number;
  shadow: boolean;
}

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface TradeMarker { time: number; side: 'buy' | 'sell'; price: number; shadow: boolean }
export interface EquityPoint { time: number; usd: number; volumeUsd: number; up: boolean }

export interface RailsState {
  maxTicketPct: number;
  dailyLossCapPct: number;
  maxOpenPositions: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxPriceImpactPct: number;
  lossStreak: number;
  pausedUntil: number | null;
  dailyLossHit: boolean;
  killSwitch: boolean;
  buysAllowed: boolean;
  blockReason: string | null;
}

export interface ThresholdsView {
  hard: { key: string; op: 'min' | 'max'; value: number; step: KillStep }[];
  soft: { key: SoftKey; op: 'min' | 'max'; value: number }[];
  maxPriceImpactPct: number;
  chain: KillStep[];
}
