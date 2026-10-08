export const AGENT_IDS = ['chief', 'scan', 'vet', 'social', 'size', 'fills', 'risk', 'crawler'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentMeta {
  id: AgentId;
  name: string;
  role: string;
  /** body colour of the pixel blob */
  color: string;
}

/** Card order: row 1 = Chief, Scan, Vet, Social · row 2 = Size, Fills, Risk, Crawler */
export const AGENTS: Record<AgentId, AgentMeta> = {
  chief: { id: 'chief', name: 'Chief', role: 'Picks one ticker from the top 3', color: '#ff5fa2' },
  scan: { id: 'scan', name: 'Scan', role: 'Momentum score from price, volume, trades', color: '#3fe0c5' },
  vet: { id: 'vet', name: 'Vet', role: 'Hard checks + is-it-real scores', color: '#ffc857' },
  social: { id: 'social', name: 'Social', role: 'Is the X handle theirs or recycled?', color: '#8fa8ff' },
  size: { id: 'size', name: 'Size', role: 'Ticket size within the rails', color: '#b98cff' },
  fills: { id: 'fills', name: 'Fills', role: 'Quote → signed swap → confirm', color: '#6be675' },
  risk: { id: 'risk', name: 'Risk', role: 'Rails, streaks, SL/TP, kill switch', color: '#ff6b5f' },
  crawler: { id: 'crawler', name: 'Crawler', role: 'Pulls new Solana tokens every minute', color: '#e8e2d4' },
};

/** Path a token walks through the office. */
export const DESK_ROUTE: AgentId[] = ['crawler', 'scan', 'vet', 'social', 'chief', 'size', 'fills'];
