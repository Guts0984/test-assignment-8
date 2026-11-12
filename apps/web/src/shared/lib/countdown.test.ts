import { describe, expect, it } from 'vitest';
import { countdown } from './countdown';

const NOW = Date.parse('2026-11-12T10:00:00Z');
const at = (min: number, sec = 0) => new Date(NOW + min * 60_000 + sec * 1000).toISOString();

describe('countdown', () => {
  it('decomposes days / hours / minutes', () => {
    expect(countdown(at(2 * 1440 + 3 * 60 + 15), NOW)).toMatchObject({
      days: 2,
      hours: 3,
      mins: 15,
      overdue: false,
      soon: false,
    });
  });
  it('"soon" is the final hour, inclusive', () => {
    expect(countdown(at(60), NOW).soon).toBe(true);
    expect(countdown(at(61), NOW).soon).toBe(false);
    expect(countdown(at(1), NOW).soon).toBe(true);
  });
  it('overdue is strictly past; exactly due is not yet overdue', () => {
    expect(countdown(at(0), NOW).overdue).toBe(false);
    expect(countdown(at(0, -1), NOW)).toMatchObject({ overdue: true, soon: false });
    expect(countdown(at(-90), NOW)).toMatchObject({
      overdue: true,
      hours: 1,
      mins: 30,
      minutes: -90,
    });
  });
  it('re-computes as the clock ticks (same deadline, later "now")', () => {
    const due = at(10);
    expect(countdown(due, NOW).mins).toBe(10);
    expect(countdown(due, NOW + 4 * 60_000).mins).toBe(6);
    expect(countdown(due, NOW + 11 * 60_000).overdue).toBe(true);
  });
});
