import type { AgentId } from '@coin/shared';

/** Logical canvas size; the canvas is scaled by an integer factor of device pixels. */
export const W = 480;
export const H = 312;

/** Iso grid: 18×18 tiles, 24×12 px each. */
export const GRID = 18;
export const TOP: [number, number] = [240, 84];
export const iso = (gx: number, gy: number): [number, number] => [TOP[0] + (gx - gy) * 12, TOP[1] + (gx + gy) * 6];
export const FLOOR = { top: iso(0, 0), left: iso(0, GRID), bottom: iso(GRID, GRID), right: iso(GRID, 0) };
export const WALL_H = 72;

/** Where each blob stands (feet) in front of its desk. Route: crawler → scan → vet → social → chief → size → fills → risk. */
export const SPOT: Record<AgentId, [number, number]> = {
  crawler: [118, 230],
  scan: [140, 182],
  vet: [190, 148],
  social: [290, 148],
  chief: [240, 200],
  size: [340, 182],
  fills: [362, 230],
  risk: [240, 276],
};

export const BIG_SCREEN = { x: 148, y: 6, w: 184, h: 72 };
export const TICKER = { x: 148, y: 81, w: 184, h: 11 };
export const BOARD = { x: 22, y: 98, w: 92, h: 60 };
