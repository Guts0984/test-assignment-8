import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLA_POLICIES,
  addBusinessMinutes,
  businessMinutesBetween,
  computeDeadlines,
  isInBusinessHours,
  remainingSlaMinutes,
  resumeDeadline,
} from '../src';

const d = (s: string) => new Date(s);
const iso = (x: Date) => x.toISOString();
// Winter: Kyiv = UTC+2. Summer: UTC+3. 2026-11-13 is a Friday; 2026-07-10 is a Friday.

describe('addBusinessMinutes', () => {
  it('stays inside the same day', () => {
    // 10:00 Kyiv + 60 min = 11:00 Kyiv = 09:00Z
    expect(iso(addBusinessMinutes(d('2026-11-12T08:00:00Z'), 60))).toBe('2026-11-12T09:00:00.000Z');
  });
  it('high priority created Friday 17:00 Kyiv: first response Monday 12:00, resolution Monday 17:00', () => {
    const created = d('2026-11-13T15:00:00Z'); // Fri 17:00 Kyiv
    const dl = computeDeadlines(created, DEFAULT_SLA_POLICIES.high);
    expect(iso(dl.firstResponseDue)).toBe('2026-11-16T10:00:00.000Z'); // Mon 12:00 Kyiv
    expect(iso(dl.resolutionDue)).toBe('2026-11-16T15:00:00.000Z'); // Mon 17:00 Kyiv
  });
  it('created on Saturday starts counting Monday 09:00', () => {
    // Sat 12:00 Kyiv = 10:00Z; normal first response = 1 business day -> Mon 18:00 Kyiv = 16:00Z
    expect(iso(addBusinessMinutes(d('2026-11-14T10:00:00Z'), 540))).toBe(
      '2026-11-16T16:00:00.000Z',
    );
  });
  it('created before opening starts at 09:00; after closing starts next workday', () => {
    expect(iso(addBusinessMinutes(d('2026-11-12T05:00:00Z'), 60))).toBe('2026-11-12T08:00:00.000Z'); // 07:00 Kyiv -> 10:00 Kyiv
    expect(iso(addBusinessMinutes(d('2026-11-12T16:30:00Z'), 60))).toBe('2026-11-13T08:00:00.000Z'); // 18:30 Kyiv Thu -> Fri 10:00
  });
  it('exactly 18:00 counts as closed', () => {
    expect(iso(addBusinessMinutes(d('2026-11-12T16:00:00Z'), 30))).toBe('2026-11-13T07:30:00.000Z'); // Fri 09:30 Kyiv
  });
  it('a full business day lands on closing time; 5 business days spans a weekend', () => {
    expect(iso(addBusinessMinutes(d('2026-11-12T07:00:00Z'), 540))).toBe(
      '2026-11-12T16:00:00.000Z',
    );
    // Thu 09:00 Kyiv + 5 days (2700m) -> Thu(540) Fri(540) Mon(540) Tue(540) Wed(540) => Wed 18:00 = 16:00Z
    expect(iso(addBusinessMinutes(d('2026-11-12T07:00:00Z'), 2700))).toBe(
      '2026-11-18T16:00:00.000Z',
    );
  });
  it('is DST-correct: summer offset (+3) and across the March switch', () => {
    // Fri 2026-07-10 17:00 Kyiv(+3) = 14:00Z; +240 min -> Mon 12:00 Kyiv = 09:00Z
    expect(iso(addBusinessMinutes(d('2026-07-10T14:00:00Z'), 240))).toBe(
      '2026-07-13T09:00:00.000Z',
    );
    // DST starts Sun 2026-03-29. Fri 03-27 17:00 Kyiv(+2)=15:00Z; +240 -> Mon 03-30 12:00 Kyiv(+3)=09:00Z
    expect(iso(addBusinessMinutes(d('2026-03-27T15:00:00Z'), 240))).toBe(
      '2026-03-30T09:00:00.000Z',
    );
    // DST ends Sun 2026-10-25. Fri 10-23 17:00 Kyiv(+3)=14:00Z; +240 -> Mon 10-26 12:00 Kyiv(+2)=10:00Z
    expect(iso(addBusinessMinutes(d('2026-10-23T14:00:00Z'), 240))).toBe(
      '2026-10-26T10:00:00.000Z',
    );
  });
  it('rejects negative / NaN minutes and returns start for 0', () => {
    expect(() => addBusinessMinutes(d('2026-11-12T08:00:00Z'), -1)).toThrow(RangeError);
    expect(() => addBusinessMinutes(d('2026-11-12T08:00:00Z'), Number.NaN)).toThrow(RangeError);
    expect(iso(addBusinessMinutes(d('2026-11-14T08:00:00Z'), 0))).toBe('2026-11-14T08:00:00.000Z');
  });
  it('result is always inside business hours or exactly at closing (property, 2000 random starts)', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    for (let i = 0; i < 2000; i += 1) {
      const start = new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 365 * 24 * 60) * 60_000);
      const mins = 1 + Math.floor(rnd() * 3000);
      const end = addBusinessMinutes(start, mins);
      expect(end.getTime()).toBeGreaterThan(start.getTime());
      // round trip: business minutes between (aligned start) and end equals mins
      expect(businessMinutesBetween(start, end)).toBeCloseTo(mins, 6);
      expect(isInBusinessHours(new Date(end.getTime() - 1))).toBe(true);
    }
  });
});

describe('businessMinutesBetween', () => {
  it('ignores nights and weekends', () => {
    // Fri 17:00 Kyiv -> Mon 10:00 Kyiv = 60 + 60
    expect(businessMinutesBetween(d('2026-11-13T15:00:00Z'), d('2026-11-16T08:00:00Z'))).toBe(120);
  });
  it('is 0 for reversed or weekend-only ranges', () => {
    expect(businessMinutesBetween(d('2026-11-16T08:00:00Z'), d('2026-11-13T15:00:00Z'))).toBe(0);
    expect(businessMinutesBetween(d('2026-11-14T00:00:00Z'), d('2026-11-15T23:00:00Z'))).toBe(0);
  });
});

describe('urgent uses wall-clock time', () => {
  it('urgent created Sat 12:00 is due Sat 13:00 / 16:00', () => {
    const dl = computeDeadlines(d('2026-11-14T10:00:00Z'), DEFAULT_SLA_POLICIES.urgent);
    expect(iso(dl.firstResponseDue)).toBe('2026-11-14T11:00:00.000Z');
    expect(iso(dl.resolutionDue)).toBe('2026-11-14T14:00:00.000Z');
  });
});

describe('pause / resume', () => {
  it('pending over a weekend does not eat the deadline', () => {
    const created = d('2026-11-13T13:00:00Z'); // Fri 15:00 Kyiv
    const { resolutionDue } = computeDeadlines(created, DEFAULT_SLA_POLICIES.high); // Mon 15:00 Kyiv
    // paused Fri 16:00 Kyiv (14:00Z): 120 min left on Friday + 360 on Monday
    const pausedAt = d('2026-11-13T14:00:00Z');
    const remaining = remainingSlaMinutes(pausedAt, resolutionDue, true);
    expect(remaining).toBe(480);
    // resumed a whole week later on Tue 10:00 Kyiv
    const resumed = resumeDeadline(d('2026-11-24T08:00:00Z'), remaining, true);
    expect(businessMinutesBetween(d('2026-11-24T08:00:00Z'), resumed)).toBe(remaining);
    expect(resumed.getTime()).toBeGreaterThan(d('2026-11-24T08:00:00Z').getTime());
  });
  it('remaining is never negative when already overdue', () => {
    expect(remainingSlaMinutes(d('2026-11-20T10:00:00Z'), d('2026-11-16T10:00:00Z'), true)).toBe(0);
    expect(remainingSlaMinutes(d('2026-11-20T10:00:00Z'), d('2026-11-16T10:00:00Z'), false)).toBe(
      0,
    );
  });
});
