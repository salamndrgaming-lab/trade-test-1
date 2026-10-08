import type { AgentId } from '@coin/shared';

/** Logical canvas size; the canvas is scaled by an integer factor. */
export const W = 320;
export const H = 208;

/** Floor diamond. */
export const FLOOR = { top: [160, 60], left: [16, 132], bottom: [160, 204], right: [304, 132] } as const;
export const WALL_H = 48;

/** Where each blob stands (feet) at its desk. Route: crawler → scan → vet → social → chief → size → fills → risk. */
export const SPOT: Record<AgentId, [number, number]> = {
  crawler: [78, 156],
  scan: [92, 124],
  vet: [124, 102],
  social: [196, 102],
  chief: [160, 134],
  size: [228, 124],
  fills: [242, 156],
  risk: [160, 184],
};

export const BIG_SCREEN = { x: 100, y: 4, w: 120, h: 50 };
export const TICKER = { x: 100, y: 55, w: 120, h: 9 };
export const BOARD = { x: 20, y: 66, w: 62, h: 40 };
