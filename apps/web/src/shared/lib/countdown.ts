export type Countdown = {
  /** whole minutes remaining (negative = overdue) */
  minutes: number;
  overdue: boolean;
  /** within the final hour */
  soon: boolean;
  days: number;
  hours: number;
  mins: number;
};

/** Time to a deadline, decomposed for display. Pure: `now` is passed in, so a ticking clock drives re-renders. */
export const countdown = (dueAt: string | Date, now: number): Countdown => {
  const diffMs = new Date(dueAt).getTime() - now;
  const overdue = diffMs < 0;
  const total = Math.floor(Math.abs(diffMs) / 60_000);
  return {
    minutes: overdue ? -total : total,
    overdue,
    soon: !overdue && diffMs <= 3_600_000,
    days: Math.floor(total / 1440),
    hours: Math.floor((total % 1440) / 60),
    mins: total % 60,
  };
};
