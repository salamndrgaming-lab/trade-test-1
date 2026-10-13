/**
 * Pixel text in Silkscreen (the dashboard's pixel font), rendered once per string+colour and
 * thresholded to hard 1-bit edges so it stays crisp when the canvas is scaled up.
 */
const FONT = (px: number) => `${px}px Silkscreen, monospace`;
const cache = new Map<string, HTMLCanvasElement>();
const measureCtx = document.createElement('canvas').getContext('2d')!;
let fontReady = false;

/** Resolves once Silkscreen is loaded; text drawn before that is re-rendered afterwards. */
export const fontLoaded: Promise<void> = (document.fonts?.load(FONT(8)) ?? Promise.resolve())
  .then(() => { fontReady = true; cache.clear(); })
  .catch(() => undefined);

export function isFontReady() {
  return fontReady;
}

export function textCanvas(text: string, color: string, px = 8): HTMLCanvasElement {
  const key = `${px}|${color}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  measureCtx.font = FONT(px);
  const w = Math.max(1, Math.ceil(measureCtx.measureText(text).width) + 1);
  const h = px + 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.font = FONT(px);
  g.textBaseline = 'top';
  g.fillStyle = '#000';
  g.fillText(text, 0, 0);
  const img = g.getImageData(0, 0, w, h);
  const n = parseInt(color.slice(1, 7), 16);
  const r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  for (let i = 0; i < img.data.length; i += 4) {
    const on = img.data[i + 3]! >= 110;
    img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = on ? 255 : 0;
  }
  g.putImageData(img, 0, 0);
  cache.set(key, c);
  return c;
}

export function textW(text: string, px = 8): number {
  return textCanvas(text, '#ffffff', px).width - 1;
}

export function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string, px = 8) {
  ctx.drawImage(textCanvas(s, color, px), Math.round(x), Math.round(y));
}

/** Text with a 1px dark outline, for labels that float over the scene. */
export function textOutlined(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string, outline = '#120b1c', px = 8) {
  const o = textCanvas(s, outline, px);
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) ctx.drawImage(o, Math.round(x) + dx, Math.round(y) + dy);
  text(ctx, s, x, y, color, px);
}

export function wrapText(s: string, maxW: number, maxLines = 3, px = 8): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textW(next, px) <= maxW) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1]!.replace(/\s*\S*$/, '') + '…';
    return cut;
  }
  return lines;
}

/**
 * Draw a canvas sheared vertically along a wall: column i shifts down by i × slope.
 * slope +0.5 follows the right wall, −0.5 the left wall.
 */
export function shearDraw(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, slope: number) {
  for (let i = 0; i < src.width; i++) ctx.drawImage(src, i, 0, 1, src.height, Math.round(x) + i, Math.round(y + i * slope), 1, src.height);
}
