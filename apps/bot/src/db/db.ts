import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentEvent, KillStep, SoftScores, TokenAnalysis } from '@coin/shared';

export type DB = Database.Database;

/** Ordered migrations. Never edit one that has shipped; add a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE tokens (
    mint            TEXT PRIMARY KEY,
    symbol          TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT '',
    pair_address    TEXT,
    source          TEXT NOT NULL,            -- profile | boost
    first_seen      INTEGER NOT NULL,         -- ms
    last_checked    INTEGER,                  -- ms
    checks          INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX tokens_first_seen ON tokens(first_seen);

  -- Latest verdict per token (the full TokenAnalysis as JSON), plus its expiry for the model-score cache.
  CREATE TABLE verdicts (
    mint            TEXT PRIMARY KEY REFERENCES tokens(mint),
    decided_at      INTEGER NOT NULL,
    day             TEXT NOT NULL,            -- UTC yyyy-mm-dd of decided_at
    died_at         TEXT,                     -- kill step or NULL
    verdict         TEXT NOT NULL,
    reason          TEXT NOT NULL DEFAULT '',
    price_usd       REAL,
    analysis_json   TEXT NOT NULL,
    soft_json       TEXT,                     -- phase 3: model scores
    soft_expires_at INTEGER                   -- phase 3: cache expiry
  );
  CREATE INDEX verdicts_day ON verdicts(day);

  -- X handles we have seen, to spot accounts recycled across tokens (phase 3 uses this).
  CREATE TABLE handles_seen (
    handle          TEXT NOT NULL,
    mint            TEXT NOT NULL,
    first_seen      INTEGER NOT NULL,
    PRIMARY KEY (handle, mint)
  );

  CREATE TABLE trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    t               INTEGER NOT NULL,
    mint            TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
    sol_in          REAL NOT NULL,
    sol_out         REAL NOT NULL,
    usd_value       REAL NOT NULL,
    fees_sol        REAL NOT NULL DEFAULT 0,
    tx_signature    TEXT,                     -- NULL in shadow mode
    shadow          INTEGER NOT NULL
  );

  CREATE TABLE balance_snapshots (
    t               INTEGER PRIMARY KEY,
    sol             REAL NOT NULL,
    usd             REAL NOT NULL,
    sol_usd         REAL NOT NULL
  );

  CREATE TABLE agent_events (
    id              TEXT PRIMARY KEY,
    t               INTEGER NOT NULL,
    agent           TEXT NOT NULL,
    kind            TEXT NOT NULL,
    json            TEXT NOT NULL
  );
  CREATE INDEX agent_events_t ON agent_events(t);

  CREATE TABLE ai_usage (
    day             TEXT NOT NULL,
    provider        TEXT NOT NULL,
    calls           INTEGER NOT NULL DEFAULT 0,
    neurons         REAL NOT NULL DEFAULT 0,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider)
  );

  CREATE TABLE settings (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
  );
  `,
  `
  -- phase 3: price at scoring time (cache is void if price moves > 20%), and Chief's picks
  ALTER TABLE verdicts ADD COLUMN soft_price REAL;
  ALTER TABLE verdicts ADD COLUMN facts_json TEXT;   -- the social facts the model was shown
  CREATE TABLE picks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    t               INTEGER NOT NULL,
    mint            TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    provider        TEXT NOT NULL,
    reason          TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX picks_t ON picks(t);
  CREATE INDEX handles_seen_handle ON handles_seen(handle, first_seen);
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export class Repo {
  constructor(readonly db: DB) {}

  knownMints(mints: string[]): Set<string> {
    if (!mints.length) return new Set();
    const rows = this.db.prepare(`SELECT mint FROM tokens WHERE mint IN (${mints.map(() => '?').join(',')})`).all(...mints) as { mint: string }[];
    return new Set(rows.map((r) => r.mint));
  }

  addToken(mint: string, source: string, t: number) {
    this.db.prepare('INSERT OR IGNORE INTO tokens (mint, source, first_seen) VALUES (?, ?, ?)').run(mint, source, t);
  }

  /** Tokens still worth re-checking: seen within the watch window, not checked within the recheck interval. */
  dueForRecheck(now: number, watchMs: number, recheckMs: number, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.mint FROM tokens t LEFT JOIN verdicts v ON v.mint = t.mint
         WHERE t.first_seen >= ? AND (t.last_checked IS NULL OR t.last_checked <= ?)
           AND (v.died_at IS NULL OR v.died_at IN ('free_kill','trade_kill','chain_kill'))
         ORDER BY t.last_checked IS NOT NULL, t.first_seen DESC LIMIT ?`,
      )
      .all(now - watchMs, now - recheckMs, limit) as { mint: string }[];
    return rows.map((r) => r.mint);
  }

  saveVerdict(a: TokenAnalysis, now: number) {
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE tokens SET symbol = ?, name = ?, pair_address = ?, last_checked = ?, checks = checks + 1 WHERE mint = ?')
        .run(a.symbol, a.name, a.pairAddress || null, now, a.mint);
      this.db
        .prepare(
          `INSERT INTO verdicts (mint, decided_at, day, died_at, verdict, reason, price_usd, analysis_json)
           VALUES (@mint, @t, @day, @died, @verdict, @reason, @price, @json)
           ON CONFLICT(mint) DO UPDATE SET decided_at = @t, day = @day, died_at = @died, verdict = @verdict,
             reason = @reason, price_usd = @price, analysis_json = @json`,
        )
        .run({ mint: a.mint, t: now, day: utcDay(now), died: a.diedAt, verdict: a.verdict, reason: a.verdictReason, price: a.metrics.priceUsd || null, json: JSON.stringify(a) });
    });
    tx();
  }

  verdictFor(mint: string): { diedAt: KillStep | null; verdict: string } | null {
    const r = this.db.prepare('SELECT died_at, verdict FROM verdicts WHERE mint = ?').get(mint) as { died_at: KillStep | null; verdict: string } | undefined;
    return r ? { diedAt: r.died_at, verdict: r.verdict } : null;
  }

  markChecked(mint: string, now: number) {
    this.db.prepare('UPDATE tokens SET last_checked = ?, checks = checks + 1 WHERE mint = ?').run(now, mint);
  }

  /** Today's funnel: tokens whose latest verdict was decided today, by the step that killed them. */
  dayStats(now: number): { scanned: number; dropped: Record<KillStep, number> } {
    const day = utcDay(now);
    const scanned = (this.db.prepare('SELECT COUNT(*) n FROM verdicts WHERE day = ?').get(day) as { n: number }).n;
    const rows = this.db.prepare('SELECT died_at, COUNT(*) n FROM verdicts WHERE day = ? AND died_at IS NOT NULL GROUP BY died_at').all(day) as { died_at: KillStep; n: number }[];
    const dropped: Record<KillStep, number> = { free_kill: 0, trade_kill: 0, chain_kill: 0, soft_kill: 0, pick: 0 };
    for (const r of rows) dropped[r.died_at] = r.n;
    return { scanned, dropped };
  }

  recentVerdicts(limit: number): TokenAnalysis[] {
    const rows = this.db.prepare('SELECT analysis_json FROM verdicts ORDER BY decided_at DESC LIMIT ?').all(limit) as { analysis_json: string }[];
    return rows.map((r) => JSON.parse(r.analysis_json) as TokenAnalysis);
  }

  /** Survivors of the arithmetic + chain checks, newest first (phase 3 sends these to the model). */
  survivors(limit: number, sinceMs: number): TokenAnalysis[] {
    const rows = this.db
      .prepare(`SELECT analysis_json FROM verdicts WHERE died_at IS NULL AND decided_at >= ? ORDER BY decided_at DESC LIMIT ?`)
      .all(sinceMs, limit) as { analysis_json: string }[];
    return rows.map((r) => JSON.parse(r.analysis_json) as TokenAnalysis);
  }

  saveEvent(e: AgentEvent) {
    this.db.prepare('INSERT OR IGNORE INTO agent_events (id, t, agent, kind, json) VALUES (?, ?, ?, ?, ?)').run(e.id, e.t, e.agent, e.kind, JSON.stringify(e));
  }

  recentEvents(limit: number): AgentEvent[] {
    const rows = this.db.prepare('SELECT json FROM agent_events ORDER BY t DESC, rowid DESC LIMIT ?').all(limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as AgentEvent).reverse();
  }

  maxEventSeq(): number {
    const r = this.db.prepare("SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) m FROM agent_events WHERE id LIKE 'e%'").get() as { m: number | null };
    return r.m ?? 0;
  }

  pruneEvents(olderThan: number) {
    this.db.prepare('DELETE FROM agent_events WHERE t < ?').run(olderThan);
  }

  saveBalance(t: number, sol: number, usd: number, solUsd: number) {
    this.db.prepare('INSERT OR REPLACE INTO balance_snapshots (t, sol, usd, sol_usd) VALUES (?, ?, ?, ?)').run(t, sol, usd, solUsd);
  }

  balances(since: number): { t: number; sol: number; usd: number }[] {
    return this.db.prepare('SELECT t, sol, usd FROM balance_snapshots WHERE t >= ? ORDER BY t').all(since) as { t: number; sol: number; usd: number }[];
  }

  firstBalanceOfDay(now: number): { sol: number; usd: number } | null {
    const start = Date.parse(utcDay(now) + 'T00:00:00Z');
    return (this.db.prepare('SELECT sol, usd FROM balance_snapshots WHERE t >= ? ORDER BY t LIMIT 1').get(start) as { sol: number; usd: number } | undefined) ?? null;
  }

  tradeVolumeBetween(from: number, to: number): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(usd_value), 0) v FROM trades WHERE t >= ? AND t < ?').get(from, to) as { v: number };
    return r.v;
  }

  // ── AI usage (per provider per UTC day) ──
  addAiUsage(day: string, provider: string, neurons: number, tokensIn: number, tokensOut: number) {
    this.db
      .prepare(
        `INSERT INTO ai_usage (day, provider, calls, neurons, tokens_in, tokens_out) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(day, provider) DO UPDATE SET calls = calls + 1, neurons = neurons + excluded.neurons,
           tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
      )
      .run(day, provider, neurons, tokensIn, tokensOut);
  }

  aiUsage(day: string): Record<string, { calls: number; neurons: number; tokensIn: number; tokensOut: number }> {
    const rows = this.db.prepare('SELECT provider, calls, neurons, tokens_in, tokens_out FROM ai_usage WHERE day = ?').all(day) as { provider: string; calls: number; neurons: number; tokens_in: number; tokens_out: number }[];
    return Object.fromEntries(rows.map((r) => [r.provider, { calls: r.calls, neurons: r.neurons, tokensIn: r.tokens_in, tokensOut: r.tokens_out }]));
  }

  // ── model-score cache ──
  getSoft(mint: string): { soft: SoftScores; expiresAt: number; price: number | null } | null {
    const r = this.db.prepare('SELECT soft_json, soft_expires_at, soft_price FROM verdicts WHERE mint = ?').get(mint) as { soft_json: string | null; soft_expires_at: number | null; soft_price: number | null } | undefined;
    if (!r?.soft_json) return null;
    return { soft: JSON.parse(r.soft_json) as SoftScores, expiresAt: r.soft_expires_at ?? 0, price: r.soft_price };
  }

  saveSoft(mint: string, soft: SoftScores, expiresAt: number, price: number) {
    this.db.prepare('UPDATE verdicts SET soft_json = ?, soft_expires_at = ?, soft_price = ? WHERE mint = ?').run(JSON.stringify(soft), expiresAt, price, mint);
  }

  saveFacts(mint: string, facts: unknown) {
    this.db.prepare('UPDATE verdicts SET facts_json = ? WHERE mint = ?').run(JSON.stringify(facts), mint);
  }

  getFacts<T>(mint: string): T | null {
    const r = this.db.prepare('SELECT facts_json FROM verdicts WHERE mint = ?').get(mint) as { facts_json: string | null } | undefined;
    return r?.facts_json ? (JSON.parse(r.facts_json) as T) : null;
  }

  /** Tokens that passed soft_kill within the window (Chief's pool). */
  shortlisted(sinceMs: number): TokenAnalysis[] {
    const rows = this.db
      .prepare(`SELECT analysis_json FROM verdicts WHERE died_at IS NULL AND verdict = 'shortlisted' AND decided_at >= ?`)
      .all(sinceMs) as { analysis_json: string }[];
    return rows.map((r) => JSON.parse(r.analysis_json) as TokenAnalysis);
  }

  // ── X handles, to spot recycled accounts ──
  recordHandle(handle: string, mint: string, t: number) {
    this.db.prepare('INSERT OR IGNORE INTO handles_seen (handle, mint, first_seen) VALUES (?, ?, ?)').run(handle, mint, t);
  }

  handleHistory(handle: string, exceptMint: string): { mint: string; symbol: string; firstSeen: number }[] {
    return (this.db
      .prepare(`SELECT h.mint, COALESCE(t.symbol, '') symbol, h.first_seen firstSeen FROM handles_seen h LEFT JOIN tokens t ON t.mint = h.mint
                WHERE h.handle = ? AND h.mint != ? ORDER BY h.first_seen LIMIT 10`)
      .all(handle, exceptMint) as { mint: string; symbol: string; firstSeen: number }[]);
  }

  // ── Chief's picks ──
  addPick(t: number, mint: string, symbol: string, provider: string, reason: string) {
    this.db.prepare('INSERT INTO picks (t, mint, symbol, provider, reason) VALUES (?, ?, ?, ?, ?)').run(t, mint, symbol, provider, reason);
  }

  picksToday(now: number): number {
    const start = Date.parse(utcDay(now) + 'T00:00:00Z');
    return (this.db.prepare('SELECT COUNT(*) n FROM picks WHERE t >= ?').get(start) as { n: number }).n;
  }

  lastPick(): { t: number; mint: string; symbol: string } | null {
    return (this.db.prepare('SELECT t, mint, symbol FROM picks ORDER BY t DESC LIMIT 1').get() as { t: number; mint: string; symbol: string } | undefined) ?? null;
  }

  getSetting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
