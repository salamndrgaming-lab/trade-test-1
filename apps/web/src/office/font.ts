/** Original 3×5 bitmap font. Each glyph is 15 bits, rows top→bottom, 3 px wide. */
const G: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111',
  '0': '111101101101111', '1': '010110010010111', '2': '110001010100111', '3': '110001010001110', '4': '101101111001001',
  '5': '111100110001110', '6': '011100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001110',
  ' ': '000000000000000', '.': '000000000000010', ',': '000000000010100', ':': '000010000010000', '-': '000000111000000',
  '+': '000010111010000', '%': '101001010100101', $: '011110010011110', '/': '001001010100100', '!': '010010010000010',
  '?': '110001010000010', "'": '010010000000000', '(': '001010010010001', ')': '100010010010100', '#': '101111101111101',
  '>': '100010001010100', '<': '001010100010001', '=': '000111000111000', '*': '000101010101000', _: '000000000000111',
  '&': '010101010101011', '·': '000000010000000', '✓': '000001101010000', '✗': '000101010101000', '→': '000010111010000',
  '|': '010010010010010', '~': '000011110000000',
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;
export const ADVANCE = 4;

export function textWidth(s: string): number {
  return s.length ? s.length * ADVANCE - 1 : 0;
}

export function drawText(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  let cx = Math.round(x);
  const cy = Math.round(y);
  for (const ch of s.toUpperCase()) {
    const g = G[ch] ?? G['?']!;
    for (let i = 0; i < 15; i++) if (g.charCodeAt(i) === 49) ctx.fillRect(cx + (i % 3), cy + Math.floor(i / 3), 1, 1);
    cx += ADVANCE;
  }
}

/** Greedy word wrap to a pixel width. */
export function wrap(s: string, maxW: number, maxLines = 3): string[] {
  const maxChars = Math.max(1, Math.floor((maxW + 1) / ADVANCE));
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (next.length <= maxChars) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w.length > maxChars ? w.slice(0, maxChars) : w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1]!.slice(0, maxChars - 1) + '.';
    return cut;
  }
  return lines;
}
