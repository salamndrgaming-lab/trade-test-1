import type { AgentId } from '../agents.js';

/** Canned one-liners for the mock desk (≤ 60 chars each). */
export const LINES: Record<AgentId, Record<string, string[]>> = {
  crawler: {
    found: ['Fresh one off the pump: $SYM', 'New pair spotted: $SYM', '$SYM just launched. Bagging it.', 'Dragging $SYM in from the feed'],
  },
  scan: {
    pass: ['$SYM momentum {M}. Passing it on.', '$SYM looks alive. {M} on the meter.', 'Volume holds up on $SYM'],
    drop: ['$SYM too young, too thin. Bin.', '$SYM: numbers do not add up.', 'Nope. $SYM fails the basics.'],
  },
  vet: {
    pass: ['$SYM mint and freeze revoked. Sells route.', 'Chain checks clean on $SYM'],
    drop: ['$SYM still has mint authority. Hard no.', '$SYM sell route is a wall. Drop.', 'Freeze authority live on $SYM. Out.', 'Impact on $SYM over 3%. Pass.'],
  },
  social: {
    pass: ['$SYM handle is theirs. Feels real.', 'Account matches the project on $SYM'],
    drop: ['$SYM handle was used for 2 coins before.', 'Recycled account on $SYM. Drop.', 'Dev wallet on $SYM still loaded. No.'],
  },
  chief: {
    pick: ['$SYM. That is the one. Size it.', 'Going with $SYM. Top of the stack.', '$SYM wins today\'s beauty contest.'],
    pass: ['Already holding. $SYM waits.', 'Rails say no. $SYM passed over.'],
  },
  size: {
    size: ['{SOL} SOL on $SYM. Inside the 2% rail.', 'Ticket: {SOL} SOL for $SYM'],
  },
  fills: {
    buy: ['Bought $SYM. Impact {I}%.', 'Filled $SYM buy, {I}% impact'],
    sell: ['Sold $SYM. {P} on the trade.', 'Out of $SYM at {P}'],
  },
  risk: {
    watch: ['Watching $SYM. SL -25 / TP +50.', 'Rails green. One slot open.'],
    sl: ['Stop-loss on $SYM. Cutting it.'],
    tp: ['Take-profit on $SYM. Banked.'],
    time: ['$SYM went nowhere. Closing it.'],
    kill: ['KILL SWITCH. Selling, buys frozen.'],
    unkill: ['Kill switch off. Back on watch.'],
    pause: ['Two losses in a row. One-hour pause.'],
  },
};

export function fill(line: string, vars: Record<string, string>): string {
  let s = line;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(k, v);
  return s.slice(0, 60);
}
