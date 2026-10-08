import type { AgentId } from './agents.js';
import type { KillStep } from './thresholds.js';
import type { AiProvider } from './state.js';

export type RiskAction = 'stop_loss' | 'take_profit' | 'pause' | 'loss_cap' | 'kill_switch' | 'kill_switch_off';

/** Everything the office animates comes from these. Visuals never trigger AI calls. */
export type AgentEvent = { id: string; t: number; agent: AgentId } & (
  | { kind: 'token_found'; mint: string; symbol: string }
  | { kind: 'handoff'; to: AgentId; mint: string; symbol: string }
  | { kind: 'check'; mint: string; step: KillStep; pass: boolean }
  | { kind: 'drop'; mint: string; symbol: string; step: KillStep; reason: string }
  | { kind: 'say'; text: string }
  | { kind: 'pick'; mint: string; symbol: string }
  | { kind: 'fill'; mint: string; symbol: string; side: 'buy' | 'sell'; sol: number; usd: number; shadow: boolean; sig: string | null }
  | { kind: 'risk'; action: RiskAction; detail: string }
  | { kind: 'ai_budget'; provider: AiProvider; pct: number }
);

export type AgentEventKind = AgentEvent['kind'];
