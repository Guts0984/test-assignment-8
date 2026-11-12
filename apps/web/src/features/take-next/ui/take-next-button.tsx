'use client';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTakeNext } from '@/entities/ticket/api/tickets';
import { isApiError } from '@/shared/api/client';
import { useAnnounce } from '@/shared/ui/announcer';
import { Button } from '@/shared/ui/button';

/** Assigns the most urgent free ticket of my categories to me (atomic on the server) and opens it. */
export const TakeNextButton = () => {
  const t = useTranslations('queue');
  const te = useTranslations('errors');
  const router = useRouter();
  const announce = useAnnounce();
  const take = useTakeNext();
  return (
    <Button
      disabled={take.isPending}
      aria-busy={take.isPending}
      onClick={() =>
        take.mutate(undefined, {
          onSuccess: (ticket) => {
            announce(t('tookTicket', { code: ticket.code }));
            router.push(`/tickets/${ticket.id}`);
          },
          onError: (e) =>
            announce(
              isApiError(e) && e.info.status === 404 ? t('queueEmpty') : te('unknown'),
              'assertive',
            ),
        })
      }
    >
      {take.isPending ? t('taking') : t('takeNext')}
    </Button>
  );
};
