'use client';
import { useTranslations } from 'next-intl';
import { useMe } from '@/entities/session/api/session';
import { CreateTicketForm } from '@/features/create-ticket/ui/create-ticket-form';

export const NewTicketPage = () => {
  const t = useTranslations('ticket.new');
  const me = useMe().data;
  return (
    <section aria-labelledby="page-title" className="grid gap-4">
      <h1 id="page-title" className="text-2xl font-semibold">
        {t('title')}
      </h1>
      {me ? <CreateTicketForm userId={me.id} /> : null}
    </section>
  );
};
