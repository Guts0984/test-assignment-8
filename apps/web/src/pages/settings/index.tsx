'use client';
import { useTranslations } from 'next-intl';
import { CannedManager } from '@/widgets/canned-manager/ui/canned-manager';
import { SlaSettings } from '@/widgets/sla-settings/ui/sla-settings';

export const SettingsPage = () => {
  const t = useTranslations('staff.settings');
  return (
    <section aria-labelledby="page-title" className="grid max-w-3xl gap-8">
      <h1 id="page-title" className="text-2xl font-semibold">
        {t('title')}
      </h1>
      <SlaSettings />
      <CannedManager />
    </section>
  );
};
