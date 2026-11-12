/**
 * SLA time math. Pure functions, no I/O. Business time = Mon–Fri 09:00–18:00 Europe/Kyiv (DST-aware).
 * Public holidays are NOT modelled (documented limitation).
 */
import type { Priority } from './enums';

export const SLA_TIME_ZONE = 'Europe/Kyiv';
export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 18;
export const BUSINESS_MINUTES_PER_DAY = (WORK_END_HOUR - WORK_START_HOUR) * 60;

const MS_MIN = 60_000;

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: SLA_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

type Day = { readonly y: number; readonly m: number; readonly d: number };

const wallParts = (ms: number) => {
  const out: Record<string, number> = {};
  for (const p of formatter.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    y: out.year as number,
    m: out.month as number,
    d: out.day as number,
    h: out.hour as number,
    min: out.minute as number,
  };
};

const dayOf = (ms: number): Day => {
  const { y, m, d } = wallParts(ms);
  return { y, m, d };
};

/** UTC instant (ms) at which the Kyiv wall clock reads the given local time. */
const wallToUtc = (day: Day, hour: number, minute = 0): number => {
  const target = Date.UTC(day.y, day.m - 1, day.d, hour, minute);
  let t = target;
  for (let i = 0; i < 3; i += 1) {
    const p = wallParts(t);
    t -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - target;
  }
  return t;
};

const weekday = (day: Day): number => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
const isWorkday = (day: Day): boolean => {
  const w = weekday(day);
  return w >= 1 && w <= 5;
};
const plusDays = (day: Day, n: number): Day => {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const nextWorkday = (day: Day): Day => {
  let next = plusDays(day, 1);
  while (!isWorkday(next)) next = plusDays(next, 1);
  return next;
};
const openAt = (day: Day) => wallToUtc(day, WORK_START_HOUR);
const closeAt = (day: Day) => wallToUtc(day, WORK_END_HOUR);

/** Earliest instant >= `ms` that lies inside business hours (18:00 sharp counts as closed). */
const alignToWindow = (ms: number): number => {
  const day = dayOf(ms);
  if (!isWorkday(day)) return openAt(nextWorkday(day));
  if (ms < openAt(day)) return openAt(day);
  if (ms < closeAt(day)) return ms;
  return openAt(nextWorkday(day));
};

export const isInBusinessHours = (date: Date): boolean =>
  alignToWindow(date.getTime()) === date.getTime();

export const addBusinessMinutes = (start: Date, minutes: number): Date => {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError('minutes must be >= 0');
  if (minutes === 0) return new Date(start.getTime());
  let cur = alignToWindow(start.getTime());
  let remaining = minutes * MS_MIN;
  for (;;) {
    const day = dayOf(cur);
    const available = closeAt(day) - cur;
    if (remaining <= available) return new Date(cur + remaining);
    remaining -= available;
    cur = openAt(nextWorkday(day));
  }
};

/** Business minutes elapsed between two instants (0 if `to <= from`). */
export const businessMinutesBetween = (from: Date, to: Date): number => {
  const a = from.getTime();
  const b = to.getTime();
  if (b <= a) return 0;
  let total = 0;
  let day = dayOf(a);
  const last = dayOf(b);
  for (let guard = 0; guard < 4000; guard += 1) {
    if (isWorkday(day)) {
      const lo = Math.max(a, openAt(day));
      const hi = Math.min(b, closeAt(day));
      if (hi > lo) total += hi - lo;
    }
    if (day.y === last.y && day.m === last.m && day.d === last.d) break;
    day = plusDays(day, 1);
  }
  return total / MS_MIN;
};

export type SlaPolicy = {
  readonly firstResponseMinutes: number;
  readonly resolutionMinutes: number;
  /** false → wall-clock minutes (used for `urgent`). */
  readonly businessHours: boolean;
};

export const addSlaMinutes = (start: Date, minutes: number, businessHours: boolean): Date =>
  businessHours ? addBusinessMinutes(start, minutes) : new Date(start.getTime() + minutes * MS_MIN);

export const computeDeadlines = (createdAt: Date, policy: SlaPolicy) => ({
  firstResponseDue: addSlaMinutes(createdAt, policy.firstResponseMinutes, policy.businessHours),
  resolutionDue: addSlaMinutes(createdAt, policy.resolutionMinutes, policy.businessHours),
});

/** Minutes left on a deadline at `now` (rounded up, never negative) — stored when the clock is paused. */
export const remainingSlaMinutes = (now: Date, due: Date, businessHours: boolean): number =>
  Math.ceil(
    businessHours
      ? businessMinutesBetween(now, due)
      : Math.max(0, (due.getTime() - now.getTime()) / MS_MIN),
  );

/** New deadline when the clock resumes with `remaining` minutes left. */
export const resumeDeadline = (now: Date, remaining: number, businessHours: boolean): Date =>
  addSlaMinutes(now, remaining, businessHours);

/** Default policy, editable by `lead`. Business day = 9 working hours = 540 minutes. */
export const DEFAULT_SLA_POLICIES: Readonly<Record<Priority, SlaPolicy>> = {
  urgent: { firstResponseMinutes: 60, resolutionMinutes: 240, businessHours: false },
  high: {
    firstResponseMinutes: 240,
    resolutionMinutes: BUSINESS_MINUTES_PER_DAY,
    businessHours: true,
  },
  normal: {
    firstResponseMinutes: BUSINESS_MINUTES_PER_DAY,
    resolutionMinutes: 3 * BUSINESS_MINUTES_PER_DAY,
    businessHours: true,
  },
  low: {
    firstResponseMinutes: 2 * BUSINESS_MINUTES_PER_DAY,
    resolutionMinutes: 5 * BUSINESS_MINUTES_PER_DAY,
    businessHours: true,
  },
};
