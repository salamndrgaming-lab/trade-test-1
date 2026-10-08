import { AGENTS, AGENT_IDS, type AgentEvent, type AgentId, type StateSnapshot } from '@coin/shared';
import { drawText, textWidth, wrap } from './font.js';
import { BIG_SCREEN, BOARD, FLOOR, H, SPOT, TICKER, W, WALL_H } from './layout.js';
import { isoBox, line, poly, rect, shade, type Pt } from './px.js';
import { BLOB_H, drawBlob, drawCoin } from './sprites.js';
import { fmtCompactUsd, fmtPrice, fmtSignedUsd } from '../data/format.js';

const C = {
  bg: '#0d0b14',
  wallL: '#231c36',
  wallR: '#1b1529',
  trim: '#ff3e9a',
  floorA: '#1a1428',
  floorB: '#1f182f',
  grid: '#261e3a',
  ink: '#f2eefb',
  ink2: '#b4abc9',
  muted: '#7d7494',
  pink: '#ff3e9a',
  teal: '#2ee6c8',
  good: '#3ddc84',
  bad: '#ff5468',
  warn: '#ffc23d',
  deskTop: '#3a3052',
  deskL: '#2a2240',
  deskR: '#211a33',
  screen: '#0a0812',
};

interface Walker {
  id: AgentId;
  x: number;
  y: number;
  home: [number, number];
  path: { x: number; y: number; then?: () => void }[];
  carrying: boolean;
  flip: boolean;
  bubble: { lines: string[]; until: number } | null;
  hopUntil: number;
  shakeUntil: number;
  monitor: { color: string; until: number } | null;
  sirenUntil: number;
}

interface Particle { x: number; y: number; vx: number; vy: number; until: number; color: string; size: number; gravity: number }
interface FloatText { x: number; y: number; text: string; color: string; start: number; until: number }
interface DataLine { from: AgentId; to: AgentId; until: number; start: number; color: string }

const GAP: Partial<Record<AgentEvent['kind'], number>> = { handoff: 450, say: 180, check: 260, drop: 400, pick: 600, fill: 500, risk: 450, token_found: 300 };
const BUBBLE_MS = 3200;
const FRAME_MS = 1000 / 30;

export class OfficeScene {
  private ctx: CanvasRenderingContext2D;
  private buf = document.createElement('canvas');
  private bctx: CanvasRenderingContext2D;
  private bg = document.createElement('canvas');
  private scale = 1;
  private raf = 0;
  private lastFrame = 0;
  private running = false;

  private state: StateSnapshot | null = null;
  private seen = new Set<string>();
  private queue: AgentEvent[] = [];
  private nextPlayAt = 0;

  private walkers: Record<AgentId, Walker>;
  private particles: Particle[] = [];
  private floats: FloatText[] = [];
  private lines: DataLine[] = [];
  private screenFlash = { color: '', until: 0 };

  onSay?: (agent: AgentId, text: string) => void;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.buf.width = W;
    this.buf.height = H;
    this.bctx = this.buf.getContext('2d')!;
    this.bg.width = W;
    this.bg.height = H;
    const walker = (id: AgentId): Walker => ({ id, x: SPOT[id][0], y: SPOT[id][1], home: SPOT[id], path: [], carrying: false, flip: false, bubble: null, hopUntil: 0, shakeUntil: 0, monitor: null, sirenUntil: 0 });
    this.walkers = Object.fromEntries(AGENT_IDS.map((id) => [id, walker(id)])) as Record<AgentId, Walker>;
    this.drawBackground(this.bg.getContext('2d')!);
  }

  /** Integer pixel scaling in device pixels so every logical pixel is a crisp square. */
  resize(cssWidth: number) {
    const dpr = window.devicePixelRatio || 1;
    this.scale = Math.max(1, Math.floor((cssWidth * dpr) / W));
    this.canvas.width = W * this.scale;
    this.canvas.height = H * this.scale;
    this.canvas.style.width = `${(W * this.scale) / dpr}px`;
    this.canvas.style.height = `${(H * this.scale) / dpr}px`;
    this.ctx.imageSmoothingEnabled = false;
    this.render(performance.now());
  }

  setState(s: StateSnapshot) {
    const first = this.state === null;
    this.state = s;
    for (const e of s.events) {
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      // don't replay history on first load, just show the latest quotes
      if (!first) this.queue.push(e);
    }
    if (this.seen.size > 500) this.seen = new Set(s.events.map((e) => e.id));
    if (first) {
      const now = performance.now();
      for (const id of AGENT_IDS) {
        const q = s.agents[id].quote;
        if (q && s.serverTime - s.agents[id].quoteAt < 8000) this.showBubble(id, q, now);
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      if (t - this.lastFrame < FRAME_MS) return;
      this.lastFrame = t;
      this.update(t);
      this.render(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Canvas client coords → agent under the pointer. */
  hitTest(clientX: number, clientY: number): AgentId | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    const y = ((clientY - r.top) / r.height) * H;
    let best: AgentId | null = null;
    let bestD = 16;
    for (const w of Object.values(this.walkers)) {
      const d = Math.hypot(w.x - x, w.y - BLOB_H / 2 - y);
      if (d < bestD) { bestD = d; best = w.id; }
    }
    return best;
  }

  /** Agent position in CSS px relative to the canvas, for HTML popovers. */
  agentCss(id: AgentId): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const w = this.walkers[id];
    return { x: (w.x / W) * r.width, y: ((w.y - BLOB_H - 4) / H) * r.height };
  }

  // ── simulation ───────────────────────────────────────────────

  private update(now: number) {
    const backlog = this.queue.length;
    while (this.queue.length && now >= this.nextPlayAt) {
      const e = this.queue.shift()!;
      this.play(e, now);
      const gap = GAP[e.kind] ?? 200;
      this.nextPlayAt = now + (backlog > 24 ? gap / 6 : backlog > 10 ? gap / 2 : gap);
    }
    // drop a huge backlog (tab was hidden): keep only the last few
    if (this.queue.length > 60) this.queue = this.queue.slice(-12);

    const dt = FRAME_MS / 1000;
    for (const w of Object.values(this.walkers)) {
      const tgt = w.path[0];
      if (tgt) {
        const dx = tgt.x - w.x, dy = tgt.y - w.y;
        const d = Math.hypot(dx, dy);
        const step = 70 * dt;
        if (d <= step) {
          w.x = tgt.x; w.y = tgt.y;
          w.path.shift();
          tgt.then?.();
        } else {
          w.x += (dx / d) * step;
          w.y += (dy / d) * step;
          if (Math.abs(dx) > 0.5) w.flip = dx < 0;
        }
      }
      if (w.bubble && now > w.bubble.until) w.bubble = null;
      if (w.monitor && now > w.monitor.until) w.monitor = null;
    }
    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.gravity * dt;
    }
    this.particles = this.particles.filter((p) => now < p.until);
    this.floats = this.floats.filter((f) => now < f.until);
    this.lines = this.lines.filter((l) => now < l.until);
  }

  private play(e: AgentEvent, now: number) {
    const w = this.walkers[e.agent];
    switch (e.kind) {
      case 'token_found':
        w.carrying = true;
        this.burst(w.x, w.y - 12, ['#ffd23f', C.teal], 8, now, 40);
        break;
      case 'handoff': {
        const to = this.walkers[e.to];
        const side = to.home[0] >= w.home[0] ? -12 : 12;
        w.carrying = true;
        this.lines.push({ from: e.agent, to: e.to, start: now, until: now + 1800, color: e.agent === 'risk' ? C.teal : C.pink });
        w.path.push({
          x: to.home[0] + side, y: to.home[1],
          then: () => { w.carrying = false; to.carrying = e.to !== 'risk'; },
        });
        w.path.push({ x: w.home[0], y: w.home[1] });
        break;
      }
      case 'check':
        w.monitor = { color: e.pass ? C.good : C.bad, until: now + 900 };
        this.float(w.x, w.y - BLOB_H - 4, e.pass ? '✓' : '✗', e.pass ? C.good : C.bad, now);
        break;
      case 'drop':
        w.carrying = false;
        w.shakeUntil = now + 500;
        w.monitor = { color: C.bad, until: now + 1200 };
        this.burst(w.x, w.y - 6, [C.bad, '#7a2633'], 10, now, 50);
        this.float(w.x, w.y - BLOB_H - 10, 'DROP', C.bad, now);
        break;
      case 'say':
        this.showBubble(e.agent, e.text, now);
        this.onSay?.(e.agent, e.text);
        break;
      case 'pick':
        w.hopUntil = now + 1400;
        this.screenFlash = { color: C.pink, until: now + 700 };
        this.burst(w.x, w.y - 12, [C.pink, C.teal, '#ffd23f'], 22, now, 70);
        this.float(w.x, w.y - BLOB_H - 12, 'PICK $' + e.symbol, C.pink, now, 1800);
        break;
      case 'fill': {
        const col = e.side === 'buy' ? C.good : C.pink;
        this.burst(w.x, w.y - 10, [col, '#ffd23f'], 14, now, 60);
        this.float(w.x, w.y - BLOB_H - 10, (e.side === 'buy' ? 'BUY ' : 'SELL ') + (e.shadow ? '(SIM)' : ''), col, now, 1600);
        w.monitor = { color: col, until: now + 1200 };
        break;
      }
      case 'risk': {
        const bad = e.action === 'stop_loss' || e.action === 'kill_switch' || e.action === 'loss_cap';
        if (bad) {
          w.sirenUntil = now + 2500;
          this.screenFlash = { color: C.bad, until: now + 900 };
        }
        if (e.action === 'take_profit') this.burst(w.x, w.y - 12, [C.good, '#ffd23f'], 16, now, 60);
        const label = { stop_loss: 'STOP-LOSS', take_profit: 'TAKE-PROFIT', pause: 'PAUSE ZZ', loss_cap: 'LOSS CAP', kill_switch: 'KILL!', kill_switch_off: 'RESUMED' }[e.action];
        this.float(w.x, w.y - BLOB_H - 12, label, bad ? C.bad : e.action === 'pause' ? C.warn : C.good, now, 2000);
        break;
      }
      case 'ai_budget':
        this.float(w.x, w.y - BLOB_H - 12, `AI ${Math.round(e.pct * 100)}% → ${e.provider.toUpperCase()}`, C.warn, now, 2500);
        break;
    }
  }

  private showBubble(id: AgentId, text: string, now: number) {
    this.walkers[id].bubble = { lines: wrap(text, 70, 3), until: now + BUBBLE_MS };
  }

  private burst(x: number, y: number, colors: string[], n: number, now: number, speed: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.5, gravity: 140, until: now + 500 + Math.random() * 500, color: colors[i % colors.length]!, size: Math.random() < 0.3 ? 2 : 1 });
    }
  }

  private float(x: number, y: number, text: string, color: string, now: number, ms = 1100) {
    this.floats.push({ x, y, text, color, start: now, until: now + ms });
  }

  // ── drawing ──────────────────────────────────────────────────

  private render(now: number) {
    const g = this.bctx;
    g.drawImage(this.bg, 0, 0);
    this.drawBigScreen(g, now);
    this.drawTicker(g, now);
    this.drawBoard(g);
    this.drawMonitors(g, now);
    this.drawLines(g, now);

    const ws = Object.values(this.walkers).sort((a, b) => a.y - b.y);
    for (const w of ws) this.drawWalker(g, w, now);
    for (const p of this.particles) rect(g, p.x, p.y, p.size, p.size, p.color);
    for (const f of this.floats) {
      const k = (now - f.start) / (f.until - f.start);
      const tw = textWidth(f.text);
      const x = clamp(f.x - tw / 2, 1, W - tw - 1);
      const y = f.y - k * 10;
      rect(g, x - 1, y - 1, tw + 2, 7, 'rgba(13,11,20,0.75)');
      drawText(g, f.text, x, y, f.color);
    }
    for (const w of ws) this.drawBubble(g, w);
    this.drawOverlay(g, now);

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.buf, 0, 0, W * this.scale, H * this.scale);
  }

  private drawWalker(g: CanvasRenderingContext2D, w: Walker, now: number) {
    const moving = w.path.length > 0;
    const hop = now < w.hopUntil ? Math.abs(Math.sin((now / 160) * Math.PI)) * 5 : 0;
    const shake = now < w.shakeUntil ? Math.round(Math.sin(now / 25) * 1.5) : 0;
    const status = this.state?.agents[w.id].status ?? 'idle';
    const bobRate = status === 'working' ? 260 : 700;
    const phase = Math.floor(now / bobRate + w.home[0]) % 2;
    const blink = Math.floor(now / 90 + w.home[1] * 7) % 40 === 0;
    const color = AGENTS[w.id].color;
    drawBlob(g, w.id, color, w.x + shake, w.y - hop, {
      walking: moving, frame: Math.floor(now / 140), blink, squash: !moving && phase === 1 && status !== 'paused', flip: w.flip,
      sirenOn: now < w.sirenUntil && Math.floor(now / 150) % 2 === 0,
    });
    if (w.carrying) {
      const by = Math.floor(now / 200) % 2;
      drawCoin(g, w.x + (w.flip ? -7 : 7), w.y - 7 - hop - by);
    }
    if (status === 'paused') drawText(g, 'Z', w.x + 6, w.y - BLOB_H - 4 - (Math.floor(now / 500) % 2), C.warn);
    if (status === 'blocked') drawText(g, '!', w.x + 6, w.y - BLOB_H - 5, C.bad);
  }

  private drawBubble(g: CanvasRenderingContext2D, w: Walker) {
    if (!w.bubble) return;
    const lines = w.bubble.lines;
    const tw = Math.max(...lines.map(textWidth));
    const bw = tw + 6, bh = lines.length * 6 + 4;
    const bx = clamp(Math.round(w.x - bw / 2), 1, W - bw - 1);
    const by = clamp(Math.round(w.y - BLOB_H - 7 - bh), 1, H - bh - 1);
    rect(g, bx, by, bw, bh, '#1a1426');
    rect(g, bx + 1, by + 1, bw - 2, bh - 2, '#f6f2ff');
    const tx = clamp(Math.round(w.x) - 1, bx + 2, bx + bw - 5);
    rect(g, tx, by + bh, 3, 1, '#1a1426');
    rect(g, tx + 1, by + bh - 1, 1, 2, '#f6f2ff');
    rect(g, tx + 1, by + bh + 1, 1, 1, '#1a1426');
    lines.forEach((l, i) => drawText(g, l, bx + 3, by + 3 + i * 6, '#1a1426'));
  }

  private monitorPos(id: AgentId): [number, number] {
    const [x, y] = SPOT[id];
    return id === 'risk' ? [x, y - 24] : id === 'chief' ? [x, y - 31] : [x, y - 27];
  }

  private drawMonitors(g: CanvasRenderingContext2D, now: number) {
    for (const id of AGENT_IDS) {
      const w = this.walkers[id];
      const [mx, my] = this.monitorPos(id);
      if (id === 'risk') {
        // siren lamp on the pedestal
        const on = now < w.sirenUntil ? Math.floor(now / 150) % 2 === 0 : this.state?.rails.killSwitch;
        rect(g, mx - 2, my, 5, 3, on ? C.bad : '#5a2030');
        rect(g, mx - 1, my - 1, 3, 1, on ? '#ffd0d8' : '#7a2c3e');
        continue;
      }
      const status = this.state?.agents[id].status ?? 'idle';
      const col = w.monitor ? w.monitor.color : status === 'working' ? AGENTS[id].color : '#2b3a4a';
      rect(g, mx - 6, my - 4, 12, 8, '#0b0912');
      rect(g, mx - 5, my - 3, 10, 6, shade(col, -0.55));
      // scanline shimmer
      const sl = Math.floor(now / 120) % 6;
      rect(g, mx - 5, my - 3 + sl, 10, 1, shade(col, -0.2));
      if (status === 'working' || w.monitor) {
        rect(g, mx - 4, my - 2, 4, 1, col);
        rect(g, mx - 4, my, 6, 1, col);
      }
      rect(g, mx - 1, my + 4, 2, 2, '#0b0912');
    }
  }

  private drawLines(g: CanvasRenderingContext2D, now: number) {
    for (const l of this.lines) {
      const [x0, y0] = this.monitorPos(l.from);
      const [x1, y1] = this.monitorPos(l.to);
      const k = (now - l.start) / (l.until - l.start);
      const off = Math.floor(now / 50);
      line(g, x0, y0 - 6, x1, y1 - 6, k > 0.75 && Math.floor(now / 60) % 2 ? shade(l.color, -0.5) : l.color, [2, 2, -off]);
      // a teal packet riding the line
      const pk = Math.min(1, k * 1.6);
      const px = x0 + (x1 - x0) * pk, py = y0 - 6 + (y1 - y0) * pk;
      rect(g, px - 1, py - 1, 3, 3, l.color === C.teal ? C.pink : C.teal);
    }
  }

  private drawBigScreen(g: CanvasRenderingContext2D, now: number) {
    const s = BIG_SCREEN;
    const st = this.state;
    rect(g, s.x - 2, s.y - 2, s.w + 4, s.h + 4, '#0b0912');
    rect(g, s.x - 1, s.y - 1, s.w + 2, s.h + 2, '#3a3052');
    rect(g, s.x, s.y, s.w, s.h, C.screen);
    const chart = st?.pickChart;
    if (!chart || chart.candles.length < 2) {
      drawText(g, 'NO PICK YET', s.x + s.w / 2 - textWidth('NO PICK YET') / 2, s.y + 18, C.muted);
      const dots = '.'.repeat(1 + (Math.floor(now / 400) % 3));
      drawText(g, 'SCANNING' + dots, s.x + s.w / 2 - textWidth('SCANNING...') / 2, s.y + 28, C.teal);
    } else {
      const last = chart.candles.at(-1)!;
      const first = chart.candles[0]!;
      const ch = (last.close / first.open - 1) * 100;
      drawText(g, '$' + chart.symbol, s.x + 3, s.y + 3, C.ink);
      const right = `${fmtPrice(last.close)} ${ch >= 0 ? '+' : ''}${ch.toFixed(0)}%`;
      drawText(g, right, s.x + s.w - 3 - textWidth(right), s.y + 3, ch >= 0 ? C.good : C.bad);
      const area = { x: s.x + 3, y: s.y + 11, w: s.w - 6, h: s.h - 14 };
      const n = Math.floor((area.w + 1) / 4);
      const cs = chart.candles.slice(-n);
      let lo = Infinity, hi = -Infinity;
      for (const c of cs) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
      for (const m of chart.markers) { lo = Math.min(lo, m.price); hi = Math.max(hi, m.price); }
      const pad = (hi - lo) * 0.08 || hi * 0.05;
      lo -= pad; hi += pad;
      const yOf = (p: number) => area.y + area.h - 1 - ((p - lo) / (hi - lo)) * (area.h - 1);
      // grid
      for (let i = 1; i < 4; i++) rect(g, area.x, area.y + Math.round((area.h * i) / 4), area.w, 1, '#161224');
      cs.forEach((c, i) => {
        const x = area.x + i * 4;
        const up = c.close >= c.open;
        const col = up ? C.good : C.bad;
        const yh = yOf(c.high), yl = yOf(c.low);
        rect(g, x + 1, Math.min(yh, yl), 1, Math.max(1, Math.abs(yl - yh)), shade(col, -0.25));
        const yo = yOf(c.open), yc = yOf(c.close);
        rect(g, x, Math.min(yo, yc), 3, Math.max(1, Math.abs(yc - yo)), col);
        for (const m of chart.markers) {
          if (m.time !== c.time) continue;
          if (m.side === 'buy') { const my = Math.min(area.y + area.h - 2, yl + 2); rect(g, x + 1, my, 1, 1, C.teal); rect(g, x, my + 1, 3, 1, C.teal); }
          else { const my = Math.max(area.y, yh - 3); rect(g, x, my, 3, 1, C.pink); rect(g, x + 1, my + 1, 1, 1, C.pink); }
        }
      });
      // entry line for the open position
      const pos = st?.position;
      if (pos && pos.mint === chart.mint) {
        const ey = Math.round(yOf(pos.entryPriceUsd));
        line(g, area.x, ey, area.x + area.w - 1, ey, C.teal, [1, 2, 0]);
      }
    }
    if (now < this.screenFlash.until && Math.floor(now / 100) % 2 === 0) {
      g.globalAlpha = 0.25;
      rect(g, s.x, s.y, s.w, s.h, this.screenFlash.color);
      g.globalAlpha = 1;
    }
    // hanging cables
    rect(g, s.x + 12, 0, 1, s.y - 1, '#3a3052');
    rect(g, s.x + s.w - 13, 0, 1, s.y - 1, '#3a3052');
  }

  private drawTicker(g: CanvasRenderingContext2D, now: number) {
    const t = TICKER;
    rect(g, t.x, t.y, t.w, t.h, '#120e1d');
    rect(g, t.x, t.y, t.w, 1, C.pink);
    const st = this.state;
    // follow whatever the big screen shows; fall back to the token being crawled
    const focus = st?.position?.mint ?? st?.pickChart?.mint;
    const tok = (focus && st?.pipeline.recent.find((r) => r.mint === focus)) || st?.pipeline.current;
    const holders = tok?.metrics.holders != null ? tok.metrics.holders.toLocaleString('en-US') : '—';
    const mcap = tok ? fmtCompactUsd(tok.metrics.mcapUsd) : '—';
    const pnl = st ? fmtSignedUsd(st.wallet.pnlTodayUsd) : '—';
    const sym = tok ? '$' + tok.symbol : '—';
    const msg = `${sym} · HOLDERS ${holders} · MCAP ${mcap} · BOT PNL ${pnl} · `;
    const mw = textWidth(msg) + 4;
    const off = Math.floor(now / 45) % mw;
    g.save();
    g.beginPath();
    g.rect(t.x + 1, t.y + 1, t.w - 2, t.h - 1);
    g.clip();
    for (let x = t.x - off; x < t.x + t.w; x += mw) drawText(g, msg, x, t.y + 3, C.ink2);
    g.restore();
  }

  private drawBoard(g: CanvasRenderingContext2D) {
    const b = BOARD;
    const st = this.state;
    rect(g, b.x - 1, b.y - 1, b.w + 2, b.h + 2, '#5a4a32');
    rect(g, b.x, b.y, b.w, b.h, '#e9e3d3');
    drawText(g, 'MANDATE', b.x + 3, b.y + 2, C.pink);
    const r = st?.rails;
    const rows: [string, string][] = r
      ? [
          [`TICKET ${r.maxTicketPct}%`, '#2a2440'],
          [`LOSS CAP ${r.dailyLossCapPct}%`, '#2a2440'],
          [`SL${r.stopLossPct} TP+${r.takeProfitPct}`, '#2a2440'],
          [`IMPACT<${r.maxPriceImpactPct}%`, '#2a2440'],
          [r.buysAllowed ? 'BUYS ON' : 'BUYS OFF', r.buysAllowed ? '#1f8f52' : '#c4283f'],
        ]
      : [];
    rows.forEach(([t, c], i) => drawText(g, t, b.x + 3, b.y + 9 + i * 6, c));
    // legs
    rect(g, b.x + 6, b.y + b.h + 1, 1, 6, '#5a4a32');
    rect(g, b.x + b.w - 7, b.y + b.h + 1, 1, 6, '#5a4a32');
  }

  private drawOverlay(g: CanvasRenderingContext2D, now: number) {
    const st = this.state;
    if (!st) return;
    // mode stamp, top-left on the wall
    const mode = st.mode === 'live' ? 'LIVE' : 'SHADOW';
    const mc = st.mode === 'live' ? C.bad : C.teal;
    rect(g, 4, 4, textWidth(mode) + 6, 9, '#0b0912');
    rect(g, 5, 5, textWidth(mode) + 4, 7, shade(mc, -0.65));
    drawText(g, mode, 7, 6, mc);
    if (st.rails.killSwitch) {
      if (Math.floor(now / 500) % 2 === 0) {
        const t = 'KILL SWITCH ON';
        const tw = textWidth(t);
        rect(g, W / 2 - tw / 2 - 4, H - 14, tw + 8, 10, C.bad);
        drawText(g, t, W / 2 - tw / 2, H - 11, '#ffffff');
      }
      g.globalAlpha = 0.08;
      rect(g, 0, 0, W, H, C.bad);
      g.globalAlpha = 1;
    } else if (!st.bot.online) {
      const t = 'BOT OFFLINE';
      rect(g, W / 2 - textWidth(t) / 2 - 4, H - 14, textWidth(t) + 8, 10, C.warn);
      drawText(g, t, W / 2 - textWidth(t) / 2, H - 11, '#1a1426');
    }
  }

  // ── static background ────────────────────────────────────────

  private drawBackground(g: CanvasRenderingContext2D) {
    rect(g, 0, 0, W, H, C.bg);
    const T = FLOOR.top as Pt, L = FLOOR.left as Pt, B = FLOOR.bottom as Pt, R = FLOOR.right as Pt;
    const up = (p: Pt, h = WALL_H): Pt => [p[0], p[1] - h];
    // walls
    poly(g, [L, T, up(T), up(L)], C.wallL);
    poly(g, [T, R, up(R), up(T)], C.wallR);
    // wall stripes
    for (let i = 1; i < 4; i++) {
      line(g, L[0], L[1] - i * 12, T[0], T[1] - i * 12, shade(C.wallL, 0.06));
      line(g, T[0], T[1] - i * 12, R[0], R[1] - i * 12, shade(C.wallR, 0.06));
    }
    // floor tiles
    const N = 18;
    const iso = (gx: number, gy: number): Pt => [T[0] + (gx - gy) * 8, T[1] + (gx + gy) * 4];
    for (let gx = 0; gx < N; gx++) {
      for (let gy = 0; gy < N; gy++) {
        poly(g, [iso(gx, gy), iso(gx + 1, gy), iso(gx + 1, gy + 1), iso(gx, gy + 1)], (gx + gy) % 2 ? C.floorA : C.floorB);
      }
    }
    // pink skirting where walls meet floor
    line(g, L[0], L[1], T[0], T[1], C.trim);
    line(g, T[0], T[1], R[0], R[1], C.trim);
    line(g, T[0], T[1], T[0], T[1] - WALL_H, shade(C.wallL, -0.3));

    // right wall window with a night sky
    const wx = 252, wy = 70;
    poly(g, [[wx, wy], [wx + 34, wy + 17], [wx + 34, wy + 3], [wx, wy - 14]], '#0a1630');
    for (const [sx, sy] of [[258, 66], [266, 64], [274, 73], [281, 71], [262, 72]] as const) rect(g, sx, sy, 1, 1, '#e9f3ff');
    line(g, wx, wy, wx + 34, wy + 17, '#3a3052');
    line(g, wx, wy - 14, wx + 34, wy + 3, '#3a3052');
    line(g, wx + 17, wy - 6, wx + 17, wy + 8, '#3a3052');
    // neon sign on the right wall
    drawText(g, 'BLOB', 222, 40, C.pink);
    drawText(g, 'DESK', 238, 48, C.teal);

    // server rack, back right
    isoBox(g, 276, 120, 4, 5, 26, '#2e2742', '#1c1729', '#15111f');
    for (let i = 0; i < 5; i++) rect(g, 278, 99 + i * 4, 6, 1, i % 2 ? C.teal : '#3ddc84');
    // plants
    this.plant(g, 40, 128);
    this.plant(g, 286, 152);
    // coffee station, left
    isoBox(g, 50, 146, 4, 3, 9, '#3a3052', '#2a2240', '#211a33');
    rect(g, 46, 132, 4, 4, '#ece6d8');
    rect(g, 47, 131, 2, 1, '#9aa3b5');

    // desks
    for (const id of AGENT_IDS) {
      const [x, y] = SPOT[id];
      if (id === 'risk') {
        isoBox(g, x, y - 6, 4, 4, 12, '#4a2232', '#3a1828', '#2c1220');
        rect(g, x - 2, y - 19, 5, 5, '#e9e3d3');
        rect(g, x - 1, y - 18, 3, 3, C.bad);
      } else if (id === 'chief') {
        isoBox(g, x, y - 6, 8, 8, 7, '#4a2f4a', '#3a2240', '#2d1a33');
        line(g, x - 16, y - 21, x, y - 13, C.pink);
        line(g, x, y - 13, x + 16, y - 21, C.pink);
      } else {
        isoBox(g, x, y - 7, 5, 5, 7, C.deskTop, C.deskL, C.deskR);
      }
    }
  }

  private plant(g: CanvasRenderingContext2D, x: number, y: number) {
    isoBox(g, x, y, 2, 2, 5, '#6b3f2a', '#55311f', '#432616');
    const leaves = [[0, -8], [-3, -10], [3, -10], [-1, -13], [2, -14], [-4, -6], [4, -6]] as const;
    for (const [dx, dy] of leaves) rect(g, x + dx - 1, y + dy - 1, 3, 2, '#3ddc84');
    for (const [dx, dy] of leaves.slice(0, 4)) rect(g, x + dx, y + dy - 1, 1, 1, '#9cf2bf');
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
