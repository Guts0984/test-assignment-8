'use client';
import { useLocalFormat } from '@/shared/lib/format';

/** A date in the viewer's own time zone (the full value is also in the `title` and `dateTime`). */
export const LocalTime = ({
  value,
  kind = 'dateTime',
}: {
  value: string | Date;
  kind?: 'dateTime' | 'date' | 'time' | 'relative';
}) => {
  const fmt = useLocalFormat();
  const iso = new Date(value).toISOString();
  const text = kind === 'relative' ? fmt.relative(value) : fmt[kind](value);
  return (
    <time
      dateTime={iso}
      title={fmt.ready ? (fmt.dateTime(value) ?? undefined) : undefined}
      suppressHydrationWarning
    >
      {text ?? ' '}
    </time>
  );
};
