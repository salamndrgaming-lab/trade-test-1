import type { AgentId } from '@coin/shared';
import { shade } from './px.js';

/**
 * Procedural pixel blobs: a shaded, outlined gumdrop with a face, cached per pose.
 * Everything is generated in code, so the art is original and recolours per agent.
 */

export const BLOB_W = 18;
export const BLOB_H = 19;
const INK = '#1a1026';

export interface BlobPose {
  walking: boolean;
  frame: number;
  blink: boolean;
  squash: boolean;
  flip: boolean;
  talking?: boolean;
  sirenOn?: boolean;
}

type Px = string | null;

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function blobPixels(color: string, squash: boolean, blink: boolean, mouthOpen: boolean, frame: number, walking: boolean): Px[][] {
  const grid: Px[][] = Array.from({ length: BLOB_H }, () => Array<Px>(BLOB_W).fill(null));
  const cx = 9;
  const rx = squash ? 7.6 : 7.1;
  const ry = squash ? 6.2 : 6.8;
  const bottom = 15.6;
  const cy = bottom - ry;
  const inside = (x: number, y: number) => {
    const dx = (x + 0.5 - cx) / rx;
    const dy = (y + 0.5 - cy) / ry;
    // rounder on top, flatter at the base: a gumdrop
    return dy <= 0 ? dx * dx + dy * dy <= 1 : Math.abs(dx) ** 2.6 + Math.abs(dy) ** 2.6 <= 1;
  };
  const tones = { hi: shade(color, 0.5), l1: shade(color, 0.22), base: color, d1: shade(color, -0.25), d2: shade(color, -0.45) };

  for (let y = 0; y < BLOB_H; y++) {
    for (let x = 0; x < BLOB_W; x++) {
      if (!inside(x, y)) continue;
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const light = -(nx * 0.55 + ny * 0.85);
      let c = light > 0.62 ? tones.hi : light > 0.2 ? tones.l1 : light > -0.5 ? tones.base : tones.d1;
      if (ny > 0.72 || nx > 0.86) c = tones.d2;
      grid[y]![x] = c;
    }
  }
  // outline
  const out: Px[][] = grid.map((r) => [...r]);
  for (let y = 0; y < BLOB_H; y++)
    for (let x = 0; x < BLOB_W; x++)
      if (!grid[y]![x] && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => grid[y + dy!]?.[x + dx!])) out[y]![x] = INK;

  const set = (x: number, y: number, c: string) => { if (y >= 0 && y < BLOB_H && x >= 0 && x < BLOB_W) out[y]![x] = c; };
  const ey = Math.round(cy) - 1;
  // specular glint
  set(5, Math.round(cy - ry + 2), '#ffffff');
  set(6, Math.round(cy - ry + 2), shade(color, 0.7));
  set(5, Math.round(cy - ry + 3), shade(color, 0.7));
  // eyes: 2×3 whites with pupils toward the facing side (sprite faces right; flip mirrors)
  for (const ex of [5, 11]) {
    if (blink) {
      set(ex, ey + 2, INK); set(ex + 1, ey + 2, INK);
    } else {
      for (let j = 0; j < 3; j++) { set(ex, ey + j, '#ffffff'); set(ex + 1, ey + j, '#ffffff'); }
      set(ex + 1, ey + 1, INK); set(ex + 1, ey + 2, INK);
      set(ex, ey, '#ffffff');
    }
  }
  // cheeks
  set(4, ey + 3, shade('#ff7aa8', 0.15));
  set(13, ey + 3, shade('#ff7aa8', 0.15));
  // mouth
  if (mouthOpen) {
    set(8, ey + 4, INK); set(9, ey + 4, INK); set(8, ey + 5, '#c2304f'); set(9, ey + 5, INK);
  } else {
    set(8, ey + 4, INK); set(9, ey + 4, INK); set(7, ey + 3, INK); set(10, ey + 3, INK);
  }
  // feet
  const lift = walking ? frame % 4 : -1;
  const foot = (x0: number, up: boolean) => {
    const fy = up ? 15 : 16;
    for (let i = 0; i < 3; i++) { set(x0 + i, fy, INK); set(x0 + i, fy + 1, i === 1 ? shade(color, -0.6) : INK); }
  };
  foot(4, lift === 0 || lift === 1);
  foot(11, lift === 2 || lift === 3);
  return out;
}

/** Accessories as pixel maps, anchored to the blob's top centre. */
interface Hat { rows: string[]; dx: number; dy: number; pal: Record<string, string> }
const HATS: Record<AgentId, Hat[]> = {
  chief: [{ rows: ['y.y.y.y', 'yyyyyyy', 'yrygyry', 'ddddddd'], dx: -3, dy: -3, pal: { y: '#ffd23f', r: '#ff3e9a', g: '#2ee6c8', d: '#b8860b' } }],
  scan: [{ rows: ['kkkkkkkkkkkkkk', 'kcckkkkkkkcckk', 'kwckkkkkkkwckk', 'kkkkkkkkkkkkkk'], dx: -7, dy: 6, pal: { k: '#22303c', c: '#2ee6c8', w: '#c8fff4' } }],
  vet: [{ rows: ['..wwwww..', '.wwwrwww.', '.wwrrrww.', 'wwwwrwwww', 'sssssssss'], dx: -4, dy: -4, pal: { w: '#f2eefb', r: '#ff5468', s: '#c9c2d8' } }],
  social: [
    { rows: ['..kkkkkkkkkkkk..', '.k............k.', 'k..............k'], dx: -8, dy: -1, pal: { k: '#2a2440' } },
    { rows: ['kk', 'kp', 'kk'], dx: -9, dy: 5, pal: { k: '#2a2440', p: '#8fa8ff' } },
    { rows: ['kk', 'pk', 'kk', '.k', '.k.', 'kkm'], dx: 7, dy: 5, pal: { k: '#2a2440', p: '#8fa8ff', m: '#ff3e9a' } },
  ],
  size: [{ rows: ['...g...', '.ggggg.', 'gggggggg', 'hhhhhhh.'], dx: -4, dy: -3, pal: { g: '#3b2f5c', h: '#5b4a8a' } }],
  fills: [{ rows: ['...yyy...', '.yyyyyyy.', '.yywyyyy.', 'yyyyyyyyy', 'ddddddddd'], dx: -4, dy: -4, pal: { y: '#ffc23d', w: '#fff1b8', d: '#a87a12' } }],
  risk: [{ rows: ['...r...', '..rrr..', '.sssss.', 'ssshsss', 'sssssss'], dx: -3, dy: -5, pal: { r: '#ff5468', s: '#8b94a8', h: '#d8dde8' } }],
  crawler: [{ rows: ['.oo.', 'oooo', '.oo.', '.k..', '.k..', '..k.'], dx: -1, dy: -6, pal: { o: '#ff3e9a', k: '#2a2440' } }],
};

const cache = new Map<string, HTMLCanvasElement>();

function render(id: AgentId, color: string, pose: BlobPose): HTMLCanvasElement {
  const talkOpen = !!pose.talking && pose.frame % 2 === 0;
  const key = `${id}|${pose.squash ? 1 : 0}${pose.blink ? 1 : 0}${talkOpen ? 1 : 0}|${pose.walking ? pose.frame % 4 : 'x'}|${pose.flip ? 1 : 0}|${pose.sirenOn ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const PAD = 7;
  const c = document.createElement('canvas');
  c.width = BLOB_W + PAD * 2;
  c.height = BLOB_H + PAD;
  const g = c.getContext('2d')!;
  const px = blobPixels(color, pose.squash, pose.blink, talkOpen, pose.frame, pose.walking);
  const top = px.findIndex((r) => r.some((v) => v && v !== null));
  for (let y = 0; y < BLOB_H; y++) for (let x = 0; x < BLOB_W; x++) {
    const v = px[y]![x];
    if (!v) continue;
    g.fillStyle = v;
    g.fillRect((pose.flip ? BLOB_W - 1 - x : x) + PAD, y + PAD, 1, 1);
  }
  for (const h of HATS[id]) {
    const pal = id === 'risk' && pose.sirenOn ? { ...h.pal, r: '#ffe0e6' } : h.pal;
    h.rows.forEach((row, ry) => [...row].forEach((ch, rx) => {
      const col = pal[ch];
      if (!col) return;
      const x = 9 + h.dx + rx;
      g.fillStyle = col;
      g.fillRect((pose.flip ? BLOB_W - 1 - x : x) + PAD, top + h.dy + ry + PAD, 1, 1);
    }));
  }
  cache.set(key, c);
  return c;
}

/** Draw a blob with its feet at (x, y). */
export function drawBlob(ctx: CanvasRenderingContext2D, id: AgentId, color: string, x: number, y: number, pose: BlobPose) {
  // dithered soft shadow
  ctx.fillStyle = 'rgba(5,2,12,0.45)';
  const sx = Math.round(x), sy = Math.round(y);
  ctx.fillRect(sx - 6, sy, 12, 1);
  ctx.fillRect(sx - 4, sy + 1, 8, 1);
  ctx.fillStyle = 'rgba(5,2,12,0.22)';
  ctx.fillRect(sx - 8, sy, 2, 1);
  ctx.fillRect(sx + 6, sy, 2, 1);
  const c = render(id, color, pose);
  ctx.drawImage(c, Math.round(x - BLOB_W / 2) - 7, Math.round(y - BLOB_H) + 1 - 7);
}

/** A still portrait for the agent cards (data URL, scaled up with pixelated rendering). */
export function blobPortrait(id: AgentId, color: string): string {
  const c = render(id, color, { walking: false, frame: 0, blink: false, squash: false, flip: false });
  return c.toDataURL();
}

const COIN = ['.oyyo.', 'oyhyyo', 'oyyydo', 'oyyydo', 'oydddo', '.oooo.'];
export function drawCoin(ctx: CanvasRenderingContext2D, x: number, y: number, tint = '#ffd23f') {
  const pal: Record<string, string> = { y: tint, h: '#fff6c9', d: shade(tint, -0.3), o: shade(tint, -0.6) };
  COIN.forEach((row, ry) => [...row].forEach((ch, rx) => {
    const col = pal[ch];
    if (!col) return;
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x) - 3 + rx, Math.round(y) - 3 + ry, 1, 1);
  }));
}

export { hexToRgb };
