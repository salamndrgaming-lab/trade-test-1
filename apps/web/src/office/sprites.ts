import type { AgentId } from '@coin/shared';
import { shade, sprite } from './px.js';

/** Original blob body, 11×10. b=body d=dark l=light w=eye white p=pupil f=feet */
const BODY = [
  '...lllll...',
  '..lbbbbbb..',
  '.lbbbbbbbb.',
  '.bbwpbbwpb.',
  '.bbwpbbwpb.',
  'bbbbbbbbbbd',
  'bbbbbbbbbbd',
  '.bbbbbbbbd.',
  '..dddddddd.',
  '..ff...ff..',
];
const BODY_BLINK = BODY.map((r, i) => (i === 3 ? '.bbbbbbbbb.' : i === 4 ? '.bbppbbppb.' : r));
const BODY_SQUASH = ['...........', ...BODY.slice(0, 1).map((r) => r), ...BODY.slice(2, 8), '..dddddddd.', '.ff.....ff.'];
const WALK = [
  BODY,
  [...BODY.slice(0, 9), '.ff.....ff.'],
];

/** Accessories drawn on top, anchored to the sprite's top-left. y can be negative. */
const HATS: Record<AgentId, { rows: string[]; dy: number; pal: Record<string, string> }> = {
  chief: { rows: ['.y.y.y.', '.yyyyy.', '.yryyy.'], dy: -3, pal: { y: '#ffd23f', r: '#ff3e9a' } },
  scan: { rows: ['...c...', '...c...', '..ccc..'], dy: -3, pal: { c: '#2ee6c8' } },
  vet: { rows: ['.wwwww.', '.wwrww.', '.wrrrw.'], dy: -2, pal: { w: '#f2eefb', r: '#ff5468' } },
  social: { rows: ['k.....k', 'kkkkkkk'], dy: -1, pal: { k: '#2a2440' } },
  size: { rows: ['..ggg..', '.ggggg.'], dy: -2, pal: { g: '#3b2f5c' } },
  fills: { rows: ['..yyy..', '.yyyyy.', 'yyyyyyy'], dy: -3, pal: { y: '#ffc23d' } },
  risk: { rows: ['...r...', '.sssss.', 'sssssss'], dy: -3, pal: { r: '#ff5468', s: '#9aa3b5' } },
  crawler: { rows: ['...o...', '...k...', '...k...'], dy: -3, pal: { o: '#ff3e9a', k: '#2a2440' } },
};

export const BLOB_W = 11;
export const BLOB_H = 10;

export interface BlobPose {
  walking: boolean;
  frame: number;
  blink: boolean;
  squash: boolean;
  flip: boolean;
  sirenOn?: boolean;
}

/** Draw a blob with its feet at (x, y). */
export function drawBlob(ctx: CanvasRenderingContext2D, id: AgentId, color: string, x: number, y: number, pose: BlobPose) {
  const ox = Math.round(x - BLOB_W / 2);
  const oy = Math.round(y - BLOB_H);
  const pal = { b: color, d: shade(color, -0.35), l: shade(color, 0.35), w: '#ffffff', p: '#1a1426', f: '#1a1426' };
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(ox + 2, oy + BLOB_H - 1, 7, 2);
  const rows = pose.walking ? WALK[pose.frame % 2]! : pose.squash ? BODY_SQUASH : pose.blink ? BODY_BLINK : BODY;
  sprite(ctx, rows, ox, oy, pal, pose.flip);
  const hat = HATS[id];
  const hatPal = id === 'risk' && pose.sirenOn ? { ...hat.pal, r: '#ffe0e6' } : hat.pal;
  const squashDy = !pose.walking && pose.squash ? 1 : 0;
  sprite(ctx, hat.rows, ox + 2, oy + hat.dy + squashDy, hatPal);
}

const COIN = ['.yy.', 'yooy', 'yooy', '.yy.'];
export function drawCoin(ctx: CanvasRenderingContext2D, x: number, y: number, tint = '#ffd23f') {
  sprite(ctx, COIN, x - 2, y - 2, { y: tint, o: shade(tint, -0.3) });
}
