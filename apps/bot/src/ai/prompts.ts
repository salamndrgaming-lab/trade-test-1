import type { TokenAnalysis } from '@coin/shared';

export interface SocialFacts {
  handle: string | null;
  /** other tokens that used the same X handle before, oldest first */
  handleHistory: { symbol: string; mint: string; firstSeen: number }[];
  websites: string[];
  description: string | null;
  ticketUsd: number;
}

const pct = (x: number | null) => (x === null ? 'unknown' : `${(x * 100).toFixed(1)}%`);
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;

export const VET_SOCIAL_SYSTEM = `You are Vet and Social, two analysts on a Solana memecoin desk.
Score one token from the facts given. Use only these facts; never invent data.
Every score is a number from 0 to 1:
- concentration_is_exit_risk: how likely the biggest holders can dump on buyers (1 = very likely)
- momentum_already_spent: how much of the move has already happened (1 = fully spent)
- liquidity_fits_ticket: whether pool liquidity comfortably absorbs our ticket both ways (1 = easily)
- account_is_the_project: whether the X account looks like this project's own (1 = clearly its own; 0 = none or someone else's)
- recycled_account: whether the X account was used for other tokens before (1 = clearly recycled)
- dev_still_loaded: how likely the creator still holds a large bag (1 = very likely)
Then write vet_quote and social_quote: one plain sentence each, under 60 characters, in the voice of a terse desk analyst.
Reply with only a JSON object with exactly these keys: concentration_is_exit_risk, momentum_already_spent, liquidity_fits_ticket, account_is_the_project, recycled_account, dev_still_loaded, vet_quote, social_quote.`;

export function vetSocialUser(a: TokenAnalysis, s: SocialFacts, now: number): string {
  const m = a.metrics;
  const hist = s.handleHistory.length
    ? s.handleHistory.map((h) => `$${h.symbol} (${Math.round((now - h.firstSeen) / 86_400_000)}d ago)`).join(', ')
    : 'none seen';
  return [
    `Token: $${a.symbol} "${a.name}"`,
    `Age: ${Math.round(m.ageMinutes)} min. Price change: 5m ${m.change5m.toFixed(1)}%, 1h ${m.change1h.toFixed(1)}%.`,
    `Liquidity ${usd(m.liquidityUsd)}, market cap ${usd(m.mcapUsd)}, 24h volume ${usd(m.volumeH24)}, 24h trades ${m.tradesH24}.`,
    `Top wallet ${pct(m.topWallet)} of supply, top 10 wallets ${pct(m.top10)} (pool and program accounts excluded).`,
    `Mint authority revoked: ${m.mintRevoked}. Freeze authority revoked: ${m.freezeRevoked}.`,
    `Our ticket ${usd(s.ticketUsd)}. Quoted price impact: buy ${m.buyImpactPct?.toFixed(2) ?? '?'}%, sell ${m.sellImpactPct?.toFixed(2) ?? '?'}%.`,
    `Momentum score from our own maths: ${a.momentum?.toFixed(2) ?? 'unknown'}.`,
    `X account: ${s.handle ? '@' + s.handle : 'none listed'}. Same handle on earlier tokens: ${hist}.`,
    `Websites: ${s.websites.length ? s.websites.slice(0, 3).join(', ') : 'none'}.`,
    `Profile text: ${s.description ? JSON.stringify(s.description.slice(0, 280)) : 'none'}.`,
  ].join('\n');
}

export const CHIEF_SYSTEM = `You are Chief, the head of a Solana memecoin desk. Pick at most one token to buy from the candidates.
Every candidate already passed the hard checks and the analysts' scores. Prefer fresh momentum, real liquidity for our ticket,
a project-owned X account and spread-out holders. Passing is allowed when none is convincing.
Reply with only a JSON object: {"pick": "<mint of the chosen token, or null>", "reason": "<one sentence>", "quote": "<under 60 characters, terse>"}.`;

export function chiefUser(cands: TokenAnalysis[]): string {
  const rows = cands.map((t) => ({
    mint: t.mint,
    symbol: t.symbol,
    ageMin: Math.round(t.metrics.ageMinutes),
    change5m: Number(t.metrics.change5m.toFixed(1)),
    change1h: Number(t.metrics.change1h.toFixed(1)),
    liquidityUsd: Math.round(t.metrics.liquidityUsd),
    mcapUsd: Math.round(t.metrics.mcapUsd),
    momentum: t.momentum,
    scores: t.soft ? Object.fromEntries(Object.entries(t.soft).filter(([k]) => k !== 'cachedUntil')) : null,
  }));
  return `Candidates (top ${rows.length} by momentum):\n${JSON.stringify(rows)}`;
}
