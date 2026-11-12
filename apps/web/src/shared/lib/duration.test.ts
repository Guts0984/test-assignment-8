import { describe, expect, it } from 'vitest';
import { formatDuration } from './duration';

const t = (k: string, v?: Record<string, number>) => `${v?.n}${k}`;
describe('formatDuration', () => {
  it.each([
    [null, '—'],
    [Number.NaN, '—'],
    [0, '0s'],
    [45, '45s'],
    [60, '1m'],
    [90, '1m 30s'],
    [600, '10m'],
    [3_600, '1h'],
    [5_400, '1h 30m'],
    [86_400, '1d'],
    [90_000, '1d 1h'],
    [-5, '0s'],
    [59.6, '1m'],
  ])('%s → %s', (input, out) => expect(formatDuration(input, t)).toBe(out));
});
