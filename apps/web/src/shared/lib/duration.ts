type T = (key: string, values?: Record<string, number>) => string;

/** 90 s → "1 хв 30 с"-style text from the catalogue (`t` = useTranslations('staff.dashboard.duration')). Null → em dash. */
export const formatDuration = (seconds: number | null, t: T): string => {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  if (d > 0) return [t('d', { n: d }), h > 0 ? t('h', { n: h }) : ''].filter(Boolean).join(' ');
  if (h > 0) return [t('h', { n: h }), m > 0 ? t('m', { n: m }) : ''].filter(Boolean).join(' ');
  if (m > 0)
    return [t('m', { n: m }), s > 0 && m < 10 ? t('s', { n: s }) : ''].filter(Boolean).join(' ');
  return t('s', { n: s });
};
