export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function fakeBase58(rng: Rng, len = 44): string {
  let s = '';
  for (let i = 0; i < len; i++) s += B58[Math.floor(rng() * B58.length)];
  return s;
}

export const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
export const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

const SYL = ['BLO', 'RP', 'ZOO', 'MEW', 'GRU', 'NK', 'PIX', 'EL', 'WOB', 'BLE', 'FRO', 'G', 'SNO', 'OT', 'KRA', 'BBY', 'DUN', 'KO', 'YEE', 'T', 'MOO', 'NCH', 'PLU', 'MP', 'SQU', 'ISH'];
export function fakeTicker(rng: Rng): string {
  const n = rng() < 0.6 ? 2 : 3;
  let s = '';
  for (let i = 0; i < n; i++) s += pick(rng, SYL);
  return s.slice(0, 8);
}
