/** Crisp pixel primitives — no anti-aliasing anywhere. */
export type Pt = readonly [number, number];

export function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** Scanline polygon fill on integer rows. */
export function poly(ctx: CanvasRenderingContext2D, pts: Pt[], c: string) {
  ctx.fillStyle = c;
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.floor(minY); y < Math.ceil(maxY); y++) {
    const sy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[(i + 1) % pts.length]!;
      if ((y1 <= sy && y2 > sy) || (y2 <= sy && y1 > sy)) xs.push(x1 + ((sy - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.round(xs[i]!), b = Math.round(xs[i + 1]!);
      if (b > a) ctx.fillRect(a, y, b - a, 1);
    }
  }
}

/** Bresenham line; `dash` = [on, off, offset] for animated dotted lines. */
export function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, c: string, dash?: [number, number, number]) {
  ctx.fillStyle = c;
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, i = 0;
  for (;;) {
    if (!dash || ((i + dash[2]) % (dash[0] + dash[1]) + dash[0] + dash[1]) % (dash[0] + dash[1]) < dash[0]) ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
    i++;
  }
}

/** Iso box standing on floor point (x, y) = its front-bottom corner. a = right extent, b = left extent, h = height. */
export function isoBox(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, b: number, h: number, top: string, left: string, right: string) {
  const F: Pt = [x, y], R: Pt = [x + 2 * a, y - a], L: Pt = [x - 2 * b, y - b], B: Pt = [x + 2 * a - 2 * b, y - a - b];
  const up = (p: Pt): Pt => [p[0], p[1] - h];
  poly(ctx, [L, F, up(F), up(L)], left);
  poly(ctx, [F, R, up(R), up(F)], right);
  poly(ctx, [up(F), up(R), up(B), up(L)], top);
}

/** Draw a pixel map: rows of chars, palette maps char → colour ('.' = transparent). */
export function sprite(ctx: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number, pal: Record<string, string>, flip = false) {
  const w = rows[0]?.length ?? 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i]!;
      if (ch === '.') continue;
      const col = pal[ch];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(x) + (flip ? w - 1 - i : i), Math.round(y) + r, 1, 1);
    }
  }
}

export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f))));
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
