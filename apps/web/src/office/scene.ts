import { AGENTS, AGENT_IDS, type AgentEvent, type AgentId, type StateSnapshot } from '@coin/shared';
import { fmtCompactUsd, fmtPrice, fmtSignedUsd } from '../data/format.js';
import { BIG_SCREEN, BOARD, FLOOR, GRID, H, SPOT, TICKER, W, WALL_H, iso } from './layout.js';
import { isoBox, line, poly, rect, shade, type Pt } from './px.js';
import { BLOB_H, drawBlob, drawCoin } from './sprites.js';
import { fontLoaded, shearDraw, text, textCanvas, textOutlined, textW, wrapText } from './text.js';

const C = {
  bg: '#0b0912',
  wallL: '#251d3a',
  wallR: '#1d172d',
  trim: '#ff3e9a',
  floorA: '#1a1429',
  floorB: '#1e172f',
  ink: '#f2eefb',
  ink2: '#b4abc9',
  muted: '#7d7494',
  pink: '#ff3e9a',
  teal: '#2ee6c8',
  good: '#3ddc84',
  bad: '#ff5468',
  warn: '#ffc23d',
  deskTop: '#43385e',
  deskL: '#2f2746',
  deskR: '#251f39',
  leg: '#16111f',
  screen: '#07060c',
  outline: '#120b1c',
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number) => BAYER[(y & 3) * 4 + (x & 3)]!;
const wallTopR = (x: number) => FLOOR.top[1] - WALL_H + (x - FLOOR.top[0]) / 2;
const wallTopL = (x: number) => FLOOR.top[1] - WALL_H + (FLOOR.top[0] - x) / 2;

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
    // redraw the static room once the pixel font is in, so its signs use it
    void fontLoaded.then(() => {
      this.drawBackground(this.bg.getContext('2d')!);
      this.render(performance.now());
    });
  }

  /** Integer pixel scaling in device pixels so every logical pixel is a crisp square. */
  resize(cssWidth: number) {
    const dpr = window.devicePixelRatio || 1;
    // integer device-pixel scaling keeps pixels square; on dense phone screens fill the width instead
    // (at 2–3 device px per pixel the uneven rounding is invisible)
    const exact = (cssWidth * dpr) / W;
    this.scale = dpr >= 2 ? Math.max(1, exact) : Math.max(1, Math.floor(exact));
    this.canvas.width = Math.round(W * this.scale);
    this.canvas.height = Math.round(H * this.scale);
    this.canvas.style.width = `${this.canvas.width / dpr}px`;
    this.canvas.style.height = `${this.canvas.height / dpr}px`;
    this.ctx.imageSmoothingEnabled = false;
    this.render(performance.now());
  }

  setState(s: StateSnapshot) {
    const first = this.state === null;
    this.state = s;
    for (const e of s.events) {
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
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

  hitTest(clientX: number, clientY: number): AgentId | null {
    const r = this.canvas.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    const y = ((clientY - r.top) / r.height) * H;
    let best: AgentId | null = null;
    let bestD = 20;
    for (const w of Object.values(this.walkers)) {
      const d = Math.hypot(w.x - x, w.y - BLOB_H / 2 - y);
      if (d < bestD) { bestD = d; best = w.id; }
    }
    return best;
  }

  agentCss(id: AgentId): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const w = this.walkers[id];
    return { x: (w.x / W) * r.width, y: ((w.y - BLOB_H - 8) / H) * r.height };
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
    if (this.queue.length > 60) this.queue = this.queue.slice(-12);

    const dt = FRAME_MS / 1000;
    for (const w of Object.values(this.walkers)) {
      const tgt = w.path[0];
      if (tgt) {
        const dx = tgt.x - w.x, dy = tgt.y - w.y;
        const d = Math.hypot(dx, dy);
        const step = 100 * dt;
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
        this.burst(w.x, w.y - 16, ['#ffd23f', C.teal], 10, now, 50);
        break;
      case 'handoff': {
        const to = this.walkers[e.to];
        const side = to.home[0] >= w.home[0] ? -16 : 16;
        w.carrying = true;
        this.lines.push({ from: e.agent, to: e.to, start: now, until: now + 1800, color: e.agent === 'risk' ? C.teal : C.pink });
        w.path.push({ x: to.home[0] + side, y: to.home[1], then: () => { w.carrying = false; to.carrying = e.to !== 'risk'; } });
        w.path.push({ x: w.home[0], y: w.home[1] });
        break;
      }
      case 'check':
        w.monitor = { color: e.pass ? C.good : C.bad, until: now + 900 };
        this.float(w.x, w.y - BLOB_H - 8, e.pass ? 'PASS' : 'FAIL', e.pass ? C.good : C.bad, now);
        break;
      case 'drop':
        w.carrying = false;
        w.shakeUntil = now + 500;
        w.monitor = { color: C.bad, until: now + 1200 };
        this.burst(w.x, w.y - 8, [C.bad, '#7a2633', '#ffd23f'], 14, now, 60);
        this.float(w.x, w.y - BLOB_H - 14, 'DROP', C.bad, now);
        break;
      case 'say':
        this.showBubble(e.agent, e.text, now);
        this.onSay?.(e.agent, e.text);
        break;
      case 'pick':
        w.hopUntil = now + 1400;
        this.screenFlash = { color: C.pink, until: now + 700 };
        this.burst(w.x, w.y - 16, [C.pink, C.teal, '#ffd23f'], 28, now, 90);
        this.float(w.x, w.y - BLOB_H - 16, 'PICK $' + e.symbol, C.pink, now, 1800);
        break;
      case 'fill': {
        const col = e.side === 'buy' ? C.good : C.pink;
        this.burst(w.x, w.y - 14, [col, '#ffd23f'], 18, now, 70);
        this.float(w.x, w.y - BLOB_H - 14, (e.side === 'buy' ? 'BUY' : 'SELL') + (e.shadow ? ' (SIM)' : ''), col, now, 1600);
        w.monitor = { color: col, until: now + 1200 };
        break;
      }
      case 'risk': {
        const bad = e.action === 'stop_loss' || e.action === 'kill_switch' || e.action === 'loss_cap';
        if (bad) {
          w.sirenUntil = now + 2500;
          this.screenFlash = { color: C.bad, until: now + 900 };
        }
        if (e.action === 'take_profit') this.burst(w.x, w.y - 16, [C.good, '#ffd23f'], 20, now, 70);
        const label = { stop_loss: 'STOP-LOSS', take_profit: 'TAKE-PROFIT', pause: 'PAUSE ZZ', loss_cap: 'LOSS CAP', kill_switch: 'KILL!', kill_switch_off: 'RESUMED' }[e.action];
        this.float(w.x, w.y - BLOB_H - 16, label, bad ? C.bad : e.action === 'pause' ? C.warn : C.good, now, 2000);
        break;
      }
      case 'ai_budget':
        this.float(w.x, w.y - BLOB_H - 16, `AI ${Math.round(e.pct * 100)}% > ${e.provider.toUpperCase()}`, C.warn, now, 2500);
        break;
    }
  }

  private showBubble(id: AgentId, s: string, now: number) {
    this.walkers[id].bubble = { lines: wrapText(s, 112, 3), until: now + BUBBLE_MS };
  }

  private burst(x: number, y: number, colors: string[], n: number, now: number, speed: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.5, gravity: 180, until: now + 500 + Math.random() * 600, color: colors[i % colors.length]!, size: Math.random() < 0.35 ? 2 : 1 });
    }
  }

  private float(x: number, y: number, s: string, color: string, now: number, ms = 1100) {
    this.floats.push({ x, y, text: s, color, start: now, until: now + ms });
  }

  // ── drawing ──────────────────────────────────────────────────

  private render(now: number) {
    const g = this.bctx;
    g.drawImage(this.bg, 0, 0);
    this.drawClock(g);
    this.drawNeon(g, now);
    this.drawRack(g, now);
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
      const tw = textW(f.text);
      const x = clamp(f.x - tw / 2, 2, W - tw - 2);
      textOutlined(g, f.text, x, f.y - k * 12, f.color);
    }
    for (const w of ws) this.drawBubble(g, w);
    this.drawOverlay(g, now);

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.buf, 0, 0, this.canvas.width, this.canvas.height);
  }

  private drawWalker(g: CanvasRenderingContext2D, w: Walker, now: number) {
    const moving = w.path.length > 0;
    const hop = now < w.hopUntil ? Math.abs(Math.sin((now / 160) * Math.PI)) * 7 : 0;
    const shake = now < w.shakeUntil ? Math.round(Math.sin(now / 25) * 2) : 0;
    const status = this.state?.agents[w.id].status ?? 'idle';
    const bobRate = status === 'working' ? 260 : 700;
    const phase = Math.floor(now / bobRate + w.home[0]) % 2;
    const blink = Math.floor(now / 90 + w.home[1] * 7) % 46 === 0;
    drawBlob(g, w.id, AGENTS[w.id].color, w.x + shake, w.y - hop, {
      walking: moving,
      frame: Math.floor(now / 110),
      blink,
      squash: !moving && phase === 1 && status !== 'paused',
      flip: w.flip,
      talking: !!w.bubble && now < w.bubble.until - BUBBLE_MS + 1600,
      sirenOn: now < w.sirenUntil && Math.floor(now / 150) % 2 === 0,
    });
    if (w.carrying) drawCoin(g, w.x + (w.flip ? -10 : 10), w.y - 10 - hop - (Math.floor(now / 200) % 2));
    if (status === 'paused') textOutlined(g, 'Z', w.x + 8, w.y - BLOB_H - 8 - (Math.floor(now / 500) % 2) * 2, C.warn);
    if (status === 'blocked') textOutlined(g, '!', w.x + 8, w.y - BLOB_H - 8, C.bad);
  }

  private drawBubble(g: CanvasRenderingContext2D, w: Walker) {
    if (!w.bubble) return;
    const lines = w.bubble.lines;
    const tw = Math.max(...lines.map((l) => textW(l)));
    const bw = tw + 8, bh = lines.length * 9 + 5;
    const bx = clamp(Math.round(w.x - bw / 2), 2, W - bw - 2);
    const by = clamp(Math.round(w.y - BLOB_H - 12 - bh), 2, H - bh - 2);
    rect(g, bx + 1, by + bh, bw - 1, 1, 'rgba(5,2,12,0.5)');
    rect(g, bx, by, bw, bh, C.outline);
    rect(g, bx + 1, by + 1, bw - 2, bh - 2, '#f6f2ff');
    rect(g, bx + 1, by + bh - 2, bw - 2, 1, '#dcd4ee');
    const tx = clamp(Math.round(w.x) - 2, bx + 3, bx + bw - 7);
    rect(g, tx, by + bh - 1, 4, 1, '#f6f2ff');
    rect(g, tx, by + bh, 4, 1, C.outline);
    rect(g, tx + 1, by + bh, 2, 1, '#f6f2ff');
    rect(g, tx + 1, by + bh + 1, 2, 1, C.outline);
    lines.forEach((l, i) => text(g, l, bx + 4, by + 3 + i * 9, '#1a1426'));
  }

  private monitorPos(id: AgentId): [number, number] {
    const [x, y] = SPOT[id];
    return id === 'risk' ? [x, y - 38] : id === 'chief' ? [x, y - 46] : [x, y - 40];
  }

  private drawMonitors(g: CanvasRenderingContext2D, now: number) {
    for (const id of AGENT_IDS) {
      const w = this.walkers[id];
      const [mx, my] = this.monitorPos(id);
      if (id === 'risk') {
        const on = now < w.sirenUntil ? Math.floor(now / 150) % 2 === 0 : !!this.state?.rails.killSwitch;
        const base = on ? C.bad : '#5a2030';
        rect(g, mx - 4, my + 2, 9, 2, '#3a1222');
        rect(g, mx - 3, my - 1, 7, 3, base);
        rect(g, mx - 2, my - 2, 5, 1, base);
        rect(g, mx - 1, my - 1, 2, 1, on ? '#ffe0e6' : '#8a3a4e');
        if (on) {
          g.globalAlpha = 0.25;
          rect(g, mx - 9, my - 6, 19, 12, C.bad);
          g.globalAlpha = 1;
        }
        continue;
      }
      const status = this.state?.agents[id].status ?? 'idle';
      const col = w.monitor ? w.monitor.color : status === 'working' ? AGENTS[id].color : '#2c4258';
      const lit = !!w.monitor || status === 'working';
      const screens = id === 'chief' ? [mx - 9, mx + 9] : [mx];
      for (const sx of screens) {
        // light spill on the desk
        if (lit) {
          g.globalAlpha = 0.16;
          rect(g, sx - 10, my + 7, 20, 5, col);
          g.globalAlpha = 1;
        }
        rect(g, sx - 6, my - 4, 12, 8, shade(col, lit ? -0.45 : -0.6));
        const sl = Math.floor(now / 110) % 8;
        rect(g, sx - 6, my - 4 + sl, 12, 1, shade(col, lit ? -0.15 : -0.45));
        if (lit) {
          rect(g, sx - 5, my - 2, 5, 1, col);
          rect(g, sx - 5, my, 8, 1, shade(col, 0.2));
          rect(g, sx - 5, my + 2, 3, 1, col);
        } else {
          rect(g, sx - 5, my - 2, 2, 1, '#4c6d8c');
        }
        rect(g, sx - 6, my - 4, 12, 1, shade(col, lit ? 0.3 : -0.3));
      }
    }
  }

  private drawLines(g: CanvasRenderingContext2D, now: number) {
    for (const l of this.lines) {
      const [x0, y0] = this.monitorPos(l.from);
      const [x1, y1] = this.monitorPos(l.to);
      const k = (now - l.start) / (l.until - l.start);
      const off = Math.floor(now / 45);
      const fade = k > 0.75 && Math.floor(now / 60) % 2;
      line(g, x0, y0 - 9, x1, y1 - 9, shade(l.color, -0.55), [3, 2, -off]);
      line(g, x0, y0 - 10, x1, y1 - 10, fade ? shade(l.color, -0.4) : l.color, [3, 2, -off]);
      const pk = Math.min(1, k * 1.6);
      const px = x0 + (x1 - x0) * pk, py = y0 - 10 + (y1 - y0) * pk;
      const pc = l.color === C.teal ? C.pink : C.teal;
      g.globalAlpha = 0.35;
      rect(g, px - 3, py - 3, 7, 7, pc);
      g.globalAlpha = 1;
      rect(g, px - 2, py - 1, 5, 3, pc);
      rect(g, px - 1, py - 2, 3, 5, pc);
      rect(g, px, py, 1, 1, '#ffffff');
    }
  }

  private drawBigScreen(g: CanvasRenderingContext2D, now: number) {
    const s = BIG_SCREEN;
    const st = this.state;
    // cables, bezel, glass
    rect(g, s.x + 18, 0, 2, s.y, '#2a2440');
    rect(g, s.x + s.w - 20, 0, 2, s.y, '#2a2440');
    rect(g, s.x - 4, s.y - 4, s.w + 8, s.h + 8, C.outline);
    rect(g, s.x - 3, s.y - 3, s.w + 6, s.h + 6, '#3a3052');
    rect(g, s.x - 3, s.y - 3, s.w + 6, 1, '#5b4d80');
    rect(g, s.x - 2, s.y - 2, s.w + 4, s.h + 4, '#1b1528');
    rect(g, s.x, s.y, s.w, s.h, C.screen);
    // power LED
    rect(g, s.x + s.w - 6, s.y + s.h + 1, 2, 1, C.teal);

    const chart = st?.pickChart;
    if (!chart || chart.candles.length < 2) {
      this.drawRadar(g, s.x + s.w / 2, s.y + 34, now);
      const t1 = 'NO PICK YET';
      text(g, t1, s.x + s.w / 2 - textW(t1) / 2, s.y + 4, C.muted);
      const dots = '.'.repeat(1 + (Math.floor(now / 400) % 3));
      text(g, 'SCANNING' + dots, s.x + s.w / 2 - textW('SCANNING...') / 2, s.y + s.h - 12, C.teal);
    } else {
      const last = chart.candles.at(-1)!;
      const first = chart.candles[0]!;
      const ch = (last.close / first.open - 1) * 100;
      text(g, '$' + chart.symbol, s.x + 4, s.y + 3, C.ink);
      const right = `${fmtPrice(last.close)} ${ch >= 0 ? '+' : ''}${ch.toFixed(0)}%`;
      text(g, right, s.x + s.w - 4 - textW(right), s.y + 3, ch >= 0 ? C.good : C.bad);
      const area = { x: s.x + 4, y: s.y + 14, w: s.w - 8, h: s.h - 18 };
      const n = Math.floor((area.w + 1) / 5);
      const cs = chart.candles.slice(-n);
      let lo = Infinity, hi = -Infinity;
      for (const c of cs) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
      for (const m of chart.markers) { lo = Math.min(lo, m.price); hi = Math.max(hi, m.price); }
      const pad = (hi - lo) * 0.08 || hi * 0.05;
      lo -= pad; hi += pad;
      const yOf = (p: number) => area.y + area.h - 1 - ((p - lo) / (hi - lo)) * (area.h - 1);
      for (let i = 1; i < 4; i++) line(g, area.x, area.y + Math.round((area.h * i) / 4), area.x + area.w - 1, area.y + Math.round((area.h * i) / 4), '#191427', [1, 2, 0]);
      cs.forEach((c, i) => {
        const x = area.x + i * 5;
        const up = c.close >= c.open;
        const col = up ? C.good : C.bad;
        const yh = yOf(c.high), yl = yOf(c.low);
        rect(g, x + 1, Math.min(yh, yl), 1, Math.max(1, Math.abs(yl - yh)), shade(col, -0.3));
        const yo = yOf(c.open), yc = yOf(c.close);
        rect(g, x, Math.min(yo, yc), 4, Math.max(1, Math.abs(yc - yo)), col);
        rect(g, x, Math.min(yo, yc), 1, Math.max(1, Math.abs(yc - yo)), shade(col, 0.25));
        for (const m of chart.markers) {
          if (m.time !== c.time) continue;
          if (m.side === 'buy') { const my = Math.min(area.y + area.h - 3, yl + 2); rect(g, x + 1, my, 2, 1, C.teal); rect(g, x, my + 1, 4, 1, C.teal); }
          else { const my = Math.max(area.y, yh - 4); rect(g, x, my, 4, 1, C.pink); rect(g, x + 1, my + 1, 2, 1, C.pink); }
        }
      });
      const ly = Math.round(yOf(last.close));
      line(g, area.x, ly, area.x + area.w - 1, ly, shade(C.teal, -0.35), [1, 3, Math.floor(now / 120)]);
      const pos = st?.position;
      if (pos && pos.mint === chart.mint) {
        const ey = Math.round(yOf(pos.entryPriceUsd));
        line(g, area.x, ey, area.x + area.w - 1, ey, C.warn, [2, 2, 0]);
      }
    }
    // scanlines + glass glare
    g.globalAlpha = 0.18;
    for (let y = s.y; y < s.y + s.h; y += 2) rect(g, s.x, y, s.w, 1, '#000000');
    g.globalAlpha = 0.05;
    poly(g, [[s.x, s.y], [s.x + 60, s.y], [s.x + 20, s.y + s.h], [s.x, s.y + s.h]], '#ffffff');
    g.globalAlpha = 1;
    if (now < this.screenFlash.until && Math.floor(now / 100) % 2 === 0) {
      g.globalAlpha = 0.22;
      rect(g, s.x, s.y, s.w, s.h, this.screenFlash.color);
      g.globalAlpha = 1;
    }
  }

  private drawRadar(g: CanvasRenderingContext2D, cx: number, cy: number, now: number) {
    const r = 16;
    for (let a = 0; a < 64; a++) {
      const t = (a / 64) * Math.PI * 2;
      rect(g, cx + Math.cos(t) * r, cy + Math.sin(t) * r * 0.9, 1, 1, '#1d4a44');
    }
    rect(g, cx - r, cy, r * 2, 1, '#14302c');
    rect(g, cx, cy - r, 1, r * 2, '#14302c');
    const t = (now / 1400) * Math.PI * 2;
    for (let k = 0; k < 5; k++) {
      const tk = t - k * 0.12;
      line(g, cx, cy, cx + Math.cos(tk) * r, cy + Math.sin(tk) * r * 0.9, k === 0 ? C.teal : shade(C.teal, -0.4 - k * 0.1));
    }
    const blip = Math.floor(now / 1400) % 3;
    rect(g, cx + [7, -9, 4][blip]!, cy + [-6, 3, 8][blip]!, 2, 2, C.pink);
  }

  private drawTicker(g: CanvasRenderingContext2D, now: number) {
    const t = TICKER;
    rect(g, t.x - 1, t.y, t.w + 2, t.h, '#100b1a');
    rect(g, t.x - 1, t.y, t.w + 2, 1, C.pink);
    const st = this.state;
    const focus = st?.position?.mint ?? st?.pickChart?.mint;
    const tok = (focus && st?.pipeline.recent.find((r) => r.mint === focus)) || st?.pipeline.current;
    const holders = tok?.metrics.holders != null ? tok.metrics.holders.toLocaleString('en-US') : '-';
    const mcap = tok ? fmtCompactUsd(tok.metrics.mcapUsd) : '-';
    const pnl = st ? fmtSignedUsd(st.wallet.pnlTodayUsd) : '-';
    const sym = tok ? '$' + tok.symbol : '-';
    const msg = `${sym}  HOLDERS ${holders}  MCAP ${mcap}  BOT PNL ${pnl}   //   `;
    const tc = textCanvas(msg, C.ink2);
    const mw = tc.width;
    const off = Math.floor(now / 40) % mw;
    g.save();
    g.beginPath();
    g.rect(t.x, t.y + 1, t.w, t.h - 1);
    g.clip();
    for (let x = t.x - off; x < t.x + t.w; x += mw) g.drawImage(tc, x, t.y + 2);
    g.restore();
  }

  private drawBoard(g: CanvasRenderingContext2D) {
    const b = BOARD;
    const r = this.state?.rails;
    // legs and frame
    rect(g, b.x + 8, b.y + b.h, 2, 14, '#5d6578');
    rect(g, b.x + b.w - 10, b.y + b.h, 2, 14, '#5d6578');
    rect(g, b.x + 4, b.y + b.h + 13, 10, 1, '#3c4252');
    rect(g, b.x + b.w - 14, b.y + b.h + 13, 10, 1, '#3c4252');
    rect(g, b.x - 2, b.y - 2, b.w + 4, b.h + 4, C.outline);
    rect(g, b.x - 1, b.y - 1, b.w + 2, b.h + 2, '#8b94a8');
    rect(g, b.x, b.y, b.w, b.h, '#ece8f4');
    rect(g, b.x, b.y, b.w, 1, '#ffffff');
    rect(g, b.x + 3, b.y + b.h - 2, b.w - 6, 2, '#c9c2d8'); // marker tray
    rect(g, b.x + 10, b.y + b.h - 3, 6, 1, C.pink);
    rect(g, b.x + 18, b.y + b.h - 3, 6, 1, C.teal);
    text(g, 'MANDATE', b.x + 4, b.y + 3, C.pink);
    rect(g, b.x + 4, b.y + 12, textW('MANDATE'), 1, '#f2a7cb');
    const rows: [string, string][] = r
      ? [
          [`TICKET ${r.maxTicketPct}%`, '#2a2440'],
          [`LOSS CAP ${r.dailyLossCapPct}%`, '#2a2440'],
          [`SL ${r.stopLossPct} TP +${r.takeProfitPct}`, '#2a2440'],
          [`IMPACT <${r.maxPriceImpactPct}%`, '#2a2440'],
          [r.buysAllowed ? 'BUYS ON' : 'BUYS OFF', r.buysAllowed ? '#1f8f52' : '#c4283f'],
        ]
      : [];
    rows.forEach(([t, c], i) => text(g, t, b.x + 4, b.y + 15 + i * 8, c));
  }

  private drawClock(g: CanvasRenderingContext2D) {
    const cx = 122, cy = 84, r = 8;
    for (let y = -r - 1; y <= r + 1; y++) for (let x = -r - 1; x <= r + 1; x++) {
      const d = Math.hypot(x, y);
      if (d <= r + 0.5) rect(g, cx + x, cy + y, 1, 1, d > r - 1 ? '#2a2440' : '#ece8f4');
    }
    for (let h = 0; h < 12; h += 3) {
      const t = (h / 12) * Math.PI * 2;
      rect(g, cx + Math.round(Math.sin(t) * (r - 2)), cy - Math.round(Math.cos(t) * (r - 2)), 1, 1, '#2a2440');
    }
    const d = new Date();
    const hr = ((d.getUTCHours() % 12) + d.getUTCMinutes() / 60) / 12;
    const mn = d.getUTCMinutes() / 60;
    line(g, cx, cy, cx + Math.round(Math.sin(hr * Math.PI * 2) * 4), cy - Math.round(Math.cos(hr * Math.PI * 2) * 4), '#1a1426');
    line(g, cx, cy, cx + Math.round(Math.sin(mn * Math.PI * 2) * 6), cy - Math.round(Math.cos(mn * Math.PI * 2) * 6), C.pink);
    text(g, 'UTC', cx - textW('UTC') / 2, cy + r + 2, C.muted);
  }

  private drawNeon(g: CanvasRenderingContext2D, now: number) {
    // a dark backing plate on the wall, then the two tubes with a faint halo; DESK flickers now and then
    const flick = Math.floor(now / 90) % 53 === 0 || Math.floor(now / 90) % 53 === 2;
    const x = 340;
    const y = wallTopR(x) + 12;
    for (let i = 0; i < 46; i++) {
      const yy = Math.round(y - 3 + i * 0.5);
      rect(g, x - 4 + i, yy, 1, 30, i === 0 || i === 45 ? '#0b0812' : '#140f1f');
    }
    const halo = (word: string, col: string, dx: number, dy: number) => {
      g.globalAlpha = 0.22;
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) shearDraw(g, textCanvas(word, col), x + dx + ox, y + dy + oy, 0.5);
      g.globalAlpha = 1;
    };
    halo('BLOB', '#ff8cc6', 0, 0);
    shearDraw(g, textCanvas('BLOB', C.pink), x, y, 0.5);
    if (!flick) halo('DESK', '#8ff5e5', 4, 13);
    shearDraw(g, textCanvas('DESK', flick ? '#155c52' : C.teal), x + 4, y + 13, 0.5);
  }

  private drawRack(g: CanvasRenderingContext2D, now: number) {
    // blinking LEDs on the server rack (body is in the static background)
    const [x, y] = [412, 204];
    for (let i = 0; i < 6; i++) {
      const on = (Math.floor(now / (200 + i * 70)) + i) % 3 !== 0;
      rect(g, x + 2, y - 40 + i * 6, 2, 1, on ? (i % 2 ? C.teal : C.good) : '#1e2f2c');
      rect(g, x + 6, y - 42 + i * 6, 1, 1, on && i === 2 ? C.warn : '#2a2232');
    }
  }

  private drawOverlay(g: CanvasRenderingContext2D, now: number) {
    const st = this.state;
    if (!st) return;
    const mode = st.mode === 'live' ? 'LIVE' : 'SHADOW';
    const mc = st.mode === 'live' ? C.bad : C.teal;
    const mw = textW(mode);
    rect(g, 5, 5, mw + 10, 13, C.outline);
    rect(g, 6, 6, mw + 8, 11, shade(mc, -0.7));
    rect(g, 6, 6, mw + 8, 1, shade(mc, -0.4));
    text(g, mode, 10, 8, mc);
    if (st.rails.killSwitch) {
      if (Math.floor(now / 500) % 2 === 0) {
        const t = 'KILL SWITCH ON';
        const tw = textW(t);
        rect(g, W / 2 - tw / 2 - 6, H - 20, tw + 12, 14, C.outline);
        rect(g, W / 2 - tw / 2 - 5, H - 19, tw + 10, 12, C.bad);
        text(g, t, W / 2 - tw / 2, H - 16, '#ffffff');
      }
      g.globalAlpha = 0.08;
      rect(g, 0, 0, W, H, C.bad);
      g.globalAlpha = 1;
    } else if (!st.bot.online) {
      const t = 'BOT OFFLINE';
      const tw = textW(t);
      rect(g, W / 2 - tw / 2 - 5, H - 19, tw + 10, 12, C.warn);
      text(g, t, W / 2 - tw / 2, H - 16, '#1a1426');
    }
  }

  // ── static background ────────────────────────────────────────

  private drawBackground(g: CanvasRenderingContext2D) {
    rect(g, 0, 0, W, H, C.bg);
    const T = FLOOR.top as Pt, L = FLOOR.left as Pt, B = FLOOR.bottom as Pt, R = FLOOR.right as Pt;
    const up = (p: Pt, h = WALL_H): Pt => [p[0], p[1] - h];

    // walls with vertical panels
    poly(g, [L, T, up(T), up(L)], C.wallL);
    poly(g, [T, R, up(R), up(T)], C.wallR);
    for (let gx = 2; gx < GRID; gx += 3) {
      const [xl, yl] = iso(0, gx);
      line(g, xl, yl - 4, xl, yl - WALL_H + 2, shade(C.wallL, -0.18));
      line(g, xl + 1, yl - 4, xl + 1, yl - WALL_H + 2, shade(C.wallL, 0.06));
      const [xr, yr] = iso(gx, 0);
      line(g, xr, yr - 4, xr, yr - WALL_H + 2, shade(C.wallR, -0.2));
      line(g, xr - 1, yr - 4, xr - 1, yr - WALL_H + 2, shade(C.wallR, 0.05));
    }
    // crown moulding
    line(g, L[0], L[1] - WALL_H, T[0], T[1] - WALL_H, shade(C.wallL, 0.25));
    line(g, T[0], T[1] - WALL_H, R[0], R[1] - WALL_H, shade(C.wallR, 0.2));
    line(g, L[0], L[1] - WALL_H + 1, T[0], T[1] - WALL_H + 1, shade(C.wallL, -0.25));
    line(g, T[0], T[1] - WALL_H + 1, R[0], R[1] - WALL_H + 1, shade(C.wallR, -0.25));
    // corner seam
    line(g, T[0], T[1], T[0], T[1] - WALL_H, shade(C.wallL, -0.35));

    // floor tiles with a hint of wear
    for (let gx = 0; gx < GRID; gx++) {
      for (let gy = 0; gy < GRID; gy++) {
        const h = ((gx * 73856093) ^ (gy * 19349663)) >>> 0;
        const base = (gx + gy) % 2 ? C.floorA : C.floorB;
        const col = h % 7 === 0 ? shade(base, 0.04) : h % 11 === 0 ? shade(base, -0.05) : base;
        poly(g, [iso(gx, gy), iso(gx + 1, gy), iso(gx + 1, gy + 1), iso(gx, gy + 1)], col);
        const [ax, ay] = iso(gx, gy);
        const [bx, by] = iso(gx + 1, gy);
        line(g, ax, ay, bx, by, shade(base, 0.08));
      }
    }
    // baseboard + pink trim
    for (let i = 0; i < 3; i++) {
      line(g, L[0], L[1] - i, T[0], T[1] - i, i === 2 ? C.trim : '#120d1d');
      line(g, T[0], T[1] - i, R[0], R[1] - i, i === 2 ? C.trim : '#120d1d');
    }
    line(g, L[0], L[1] - 3, T[0], T[1] - 3, shade(C.trim, -0.45));
    line(g, T[0], T[1] - 3, R[0], R[1] - 3, shade(C.trim, -0.45));

    // chief's rug
    const [rcx, rcy] = [240, 190];
    poly(g, [[rcx - 60, rcy], [rcx, rcy - 30], [rcx + 60, rcy], [rcx, rcy + 30]], '#3a1d3c');
    poly(g, [[rcx - 54, rcy], [rcx, rcy - 27], [rcx + 54, rcy], [rcx, rcy + 27]], '#4a2550');
    for (const [a, b] of [[[rcx - 54, rcy], [rcx, rcy - 27]], [[rcx, rcy - 27], [rcx + 54, rcy]], [[rcx + 54, rcy], [rcx, rcy + 27]], [[rcx, rcy + 27], [rcx - 54, rcy]]] as const)
      line(g, a[0], a[1], b[0], b[1], shade(C.pink, -0.35), [2, 2, 0]);

    // window on the right wall: night sky, moon, skyline
    const win = document.createElement('canvas');
    win.width = 50; win.height = 34;
    const wg = win.getContext('2d')!;
    for (let y = 0; y < 34; y++) for (let x = 0; x < 50; x++) {
      const t = y / 34;
      wg.fillStyle = t + (bayer(x, y) - 0.5) * 0.25 < 0.55 ? '#0b1430' : '#14244f';
      wg.fillRect(x, y, 1, 1);
    }
    for (const [sx, sy] of [[4, 4], [12, 9], [20, 3], [33, 7], [44, 5], [27, 12], [8, 14]] as const) { wg.fillStyle = '#e9f3ff'; wg.fillRect(sx, sy, 1, 1); }
    wg.fillStyle = '#f6efc9'; wg.fillRect(36, 3, 5, 5); wg.fillStyle = '#0b1430'; wg.fillRect(38, 2, 4, 4);
    const sky = [[0, 22, 7], [7, 18, 6], [13, 25, 5], [18, 15, 8], [26, 21, 6], [32, 17, 7], [39, 24, 5], [44, 19, 6]] as const;
    for (const [bx, top, bw] of sky) {
      wg.fillStyle = '#070b1d'; wg.fillRect(bx, top, bw, 34 - top);
      for (let wy = top + 2; wy < 32; wy += 3) for (let wx = bx + 1; wx < bx + bw - 1; wx += 2) if (((wx * 7 + wy * 13) % 5) === 0) { wg.fillStyle = '#ffd86b'; wg.fillRect(wx, wy, 1, 1); }
    }
    wg.fillStyle = '#3a3052'; wg.fillRect(0, 0, 50, 1); wg.fillRect(0, 33, 50, 1); wg.fillRect(0, 0, 1, 34); wg.fillRect(49, 0, 1, 34); wg.fillRect(24, 0, 2, 34); wg.fillRect(0, 16, 50, 1);
    shearDraw(g, win, 400, wallTopR(400) + 14, 0.5);
    // sill
    line(g, 399, wallTopR(399) + 49, 450, wallTopR(450) + 49, '#4a3f68');

    // whiteboard shadow on the floor
    g.globalAlpha = 0.25;
    poly(g, [[BOARD.x + 6, BOARD.y + BOARD.h + 14], [BOARD.x + BOARD.w - 6, BOARD.y + BOARD.h + 14], [BOARD.x + BOARD.w + 8, BOARD.y + BOARD.h + 20], [BOARD.x + 20, BOARD.y + BOARD.h + 20]], '#000000');
    g.globalAlpha = 1;

    // dithered light pools: the big screen on the floor, moonlight from the window
    this.lightPool(g, 240, 118, 96, 30, '#2ee6c8', 0.09);
    this.lightPool(g, 360, 188, 34, 12, '#8fb4ff', 0.07);
    this.lightPool(g, 360, wallTopR(360) + 26, 30, 18, '#ff3e9a', 0.08);

    // props
    this.drawRackBody(g);
    this.plant(g, 52, 190);
    this.plant(g, 398, 214);
    // coffee station
    isoBox(g, 78, 210, 5, 4, 14, '#3a3052', '#2a2240', '#211a33');
    rect(g, 72, 186, 8, 7, '#d8d2e4');
    rect(g, 73, 187, 6, 2, '#2a2240');
    rect(g, 75, 193, 2, 2, '#6b3f2a');
    rect(g, 81, 190, 3, 3, '#ece6d8');
    // trash bin (dropped tokens land here)
    isoBox(g, 100, 202, 3, 3, 9, '#3c4252', '#2a2f3c', '#20242e');
    poly(g, [[94, 190], [100, 187], [106, 190], [100, 193]], '#14171f');

    // desks
    for (const id of AGENT_IDS) {
      const [x, y] = SPOT[id];
      if (id === 'risk') this.drawPedestal(g, x, y);
      else if (id === 'chief') this.drawDesk(g, x, y, 11, true);
      else this.drawDesk(g, x, y, 8, false);
    }

    // soft vignette
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
      const v = Math.max(0, Math.hypot(dx * 0.9, dy) - 0.82);
      if (v > 0 && bayer(x, y) < v * 2.2) {
        g.fillStyle = 'rgba(4,2,10,0.35)';
        g.fillRect(x, y, 1, 1);
      }
    }
  }

  private lightPool(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string, alpha: number) {
    g.fillStyle = color;
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (d >= 1) continue;
      const t = 1 - d;
      if (bayer(x, y) < t * 1.4) {
        g.globalAlpha = alpha * (t > 0.5 ? 2 : 1);
        g.fillRect(x, y, 1, 1);
      }
    }
    g.globalAlpha = 1;
  }

  private drawDesk(g: CanvasRenderingContext2D, x: number, y: number, a: number, chief: boolean) {
    const F: Pt = [x, y - 9];
    const top = chief ? '#5a3a5e' : C.deskTop, left = chief ? '#432a48' : C.deskL, right = chief ? '#35213b' : C.deskR;
    // shadow
    g.globalAlpha = 0.3;
    poly(g, [[x, y - 6], [x + a * 2 + 2, y - a - 6], [x, y - 2 * a - 6], [x - a * 2 - 2, y - a - 6]], '#000000');
    g.globalAlpha = 1;
    // legs
    for (const [lx, ly] of [F, [x - a * 2 + 1, y - 9 - a], [x + a * 2 - 2, y - 9 - a]] as const) rect(g, lx, ly - 8, 2, 8, C.leg);
    // slab
    isoBox(g, x, y - 17, a, a, 3, top, left, right);
    line(g, x - a * 2, y - 20 - a, x, y - 20, shade(top, 0.18));
    line(g, x, y - 20, x + a * 2, y - 20 - a, shade(top, 0.1));
    // keyboard + mug
    poly(g, [[x - 7, y - 24], [x, y - 21], [x + 7, y - 24], [x, y - 27]], '#211b31');
    for (let i = -4; i <= 4; i += 2) rect(g, x + i, y - 24 + Math.abs(i) / 3, 1, 1, '#4a4166');
    rect(g, x + (chief ? 16 : 11), y - 30, 3, 3, '#ece6d8');
    rect(g, x + (chief ? 19 : 14), y - 29, 1, 1, '#ece6d8');
    // monitors (screens are drawn live in drawMonitors)
    const screens = chief ? [x - 9, x + 9] : [x];
    const my = chief ? y - 46 : y - 40;
    for (const sx of screens) {
      rect(g, sx - 3, my + 9, 6, 1, '#0d0a16');
      rect(g, sx - 1, my + 5, 2, 4, '#0d0a16');
      rect(g, sx - 8, my - 6, 16, 12, C.outline);
      rect(g, sx - 7, my - 5, 14, 10, '#0d0a16');
    }
  }

  private drawPedestal(g: CanvasRenderingContext2D, x: number, y: number) {
    g.globalAlpha = 0.3;
    poly(g, [[x, y - 4], [x + 12, y - 10], [x, y - 16], [x - 12, y - 10]], '#000000');
    g.globalAlpha = 1;
    isoBox(g, x, y - 8, 5, 5, 20, '#5a2638', '#451c2c', '#361522');
    line(g, x - 10, y - 33, x, y - 28, shade('#5a2638', 0.25));
    line(g, x, y - 28, x + 10, y - 33, shade('#5a2638', 0.15));
    // shield emblem on the front-right face
    rect(g, x + 3, y - 22, 5, 5, '#e9e3d3');
    rect(g, x + 4, y - 17, 3, 1, '#e9e3d3');
    rect(g, x + 4, y - 21, 3, 3, C.bad);
  }

  private drawRackBody(g: CanvasRenderingContext2D) {
    const [x, y] = [412, 204];
    isoBox(g, x, y, 4, 7, 46, '#2e2742', '#1c1729', '#15111f');
    for (let i = 0; i < 6; i++) rect(g, x + 1, y - 41 + i * 6, 7, 4, '#0f0c17');
    line(g, x - 14, y - 53, x, y - 46, shade('#2e2742', 0.25));
  }

  private plant(g: CanvasRenderingContext2D, x: number, y: number) {
    isoBox(g, x, y, 3, 3, 7, '#7a4a32', '#5f3a25', '#4a2c1b');
    poly(g, [[x - 6, y - 10], [x, y - 13], [x + 6, y - 10], [x, y - 7]], '#2e1d14');
    const leaves = [[0, -12], [-4, -15], [4, -15], [-2, -19], [3, -20], [-6, -11], [6, -11], [0, -22], [-5, -18], [5, -17]] as const;
    for (const [dx, dy] of leaves) rect(g, x + dx - 2, y + dy - 1, 4, 3, '#2a9d5c');
    for (const [dx, dy] of leaves) rect(g, x + dx - 1, y + dy - 1, 2, 1, '#3ddc84');
    for (const [dx, dy] of leaves.slice(0, 5)) rect(g, x + dx, y + dy - 1, 1, 1, '#9cf2bf');
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export { wallTopL };
