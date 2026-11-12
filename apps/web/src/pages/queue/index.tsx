'use client';
import { useTranslations } from 'next-intl';

/** Placeholder until the feature block lands. */
export const QueuePage = () => {
  const t = useTranslations();
  return (
    <section aria-labelledby="page-title">
      <h1 id="page-title" className="text-2xl font-semibold">
        {t('nav.queue')}
      </h1>
      <p className="mt-2 text-muted-foreground">{t('tickets.comingSoon')}</p>
    </section>
  );
};
