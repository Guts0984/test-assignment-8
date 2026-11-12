/** Deterministic PRNG so the seed is reproducible (mulberry32). */
export type Rng = {
  next: () => number;
  int: (min: number, max: number) => number;
  chance: (p: number) => boolean;
  pick: <T>(items: readonly T[]) => T;
  weighted: <T>(items: ReadonlyArray<readonly [T, number]>) => T;
  uuid: () => string;
  shuffle: <T>(items: readonly T[]) => T[];
};

export const createRng = (seed: number): Rng => {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min;
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  };
  const weighted = <T>(items: ReadonlyArray<readonly [T, number]>): T => {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    const last = items[items.length - 1];
    if (!last) throw new Error('weighted from empty list');
    return last[0];
  };
  const uuid = () => {
    const hex = Array.from({ length: 32 }, () => int(0, 15).toString(16));
    hex[12] = '4';
    hex[16] = '89ab'[int(0, 3)] as string;
    const h = hex.join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  return { next, int, chance: (p) => next() < p, pick, weighted, uuid, shuffle };
};
