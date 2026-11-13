'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTakeNext } from '@/entities/ticket/api/tickets';
import { isApiError } from '@/shared/api/client';
import { useAnnounce } from '@/shared/ui/announcer';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';

/** Assigns the most urgent free ticket of my categories to me (atomic on the server) and opens it. */
export const TakeNextButton = () => {
  const t = useTranslations('queue');
  const te = useTranslations('errors');
  const router = useRouter();
  const announce = useAnnounce();
  const take = useTakeNext();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid justify-items-end gap-2">
      <Button
        disabled={take.isPending}
        aria-busy={take.isPending}
        onClick={() => {
          setError(null);
          take.mutate(undefined, {
            onSuccess: (ticket) => {
              announce(t('tookTicket', { code: ticket.code }));
              router.push(`/tickets/${ticket.id}`);
            },
            // shown on screen (an Alert is also announced to screen readers); not only spoken
            onError: (e) =>
              setError(isApiError(e) && e.info.status === 404 ? t('queueEmpty') : te('unknown')),
          });
        }}
      >
        {take.isPending ? t('taking') : t('takeNext')}
      </Button>
      {error ? <Alert data-testid="take-next-error">{error}</Alert> : null}
    </div>
  );
};
