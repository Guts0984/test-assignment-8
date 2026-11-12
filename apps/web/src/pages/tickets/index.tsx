'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { useMe } from '@/entities/session/api/session';
import { useTicketList } from '@/entities/ticket/api/tickets';
import { StatusBadge } from '@/entities/ticket/ui/badges';
import { DEFAULT_FILTERS } from '@/entities/ticket/model/filters';
import { describeError } from '@/shared/lib/error-message';
import { isApiError } from '@/shared/api/client';
import { Alert } from '@/shared/ui/alert';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { LocalTime } from '@/shared/ui/local-time';

/** The customer's own tickets. Replies from support are highlighted until the ticket is opened. */
export const TicketsPage = () => {
  const t = useTranslations();
  const me = useMe().data;
  const list = useTicketList(DEFAULT_FILTERS, me?.id ?? '');
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = items.filter((i) => i.unread).length;
  useEffect(() => {
    document.title = `${t('ticket.list.title')} · ${t('app.name')}`;
  }, [t]);
  return (
    <section aria-labelledby="page-title" className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="page-title" className="text-2xl font-semibold">
          {t('ticket.list.title')}
        </h1>
        {unread > 0 ? <Badge>{t('tickets.unread', { count: unread })}</Badge> : null}
        <Button asChild className="ml-auto">
          <Link href="/tickets/new">{t('nav.newTicket')}</Link>
        </Button>
      </div>
      {list.isError ? (
        <Alert>
          {isApiError(list.error)
            ? describeError((k, v) => t(`errors.${k}`, v), list.error.info)
            : t('errors.unknown')}
        </Alert>
      ) : null}
      {list.isPending ? (
        <p role="status" className="text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : null}
      {!list.isPending && items.length === 0 ? (
        <div className="grid justify-items-start gap-3">
          <p className="text-muted-foreground">{t('ticket.list.empty')}</p>
          <Button asChild>
            <Link href="/tickets/new">{t('ticket.list.createFirst')}</Link>
          </Button>
        </div>
      ) : null}
      <ul className="grid gap-2" aria-label={t('ticket.list.title')}>
        {items.map((i) => (
          <li key={i.id}>
            <Link
              href={`/tickets/${i.id}`}
              data-unread={i.unread}
              className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${i.unread ? 'border-primary bg-accent font-semibold' : 'border-border'}`}
            >
              <span className="font-mono text-sm text-muted-foreground">{i.code}</span>
              <span className="min-w-0 flex-1 truncate">{i.subject}</span>
              {i.unread ? <Badge>{t('ticket.list.unread')}</Badge> : null}
              <StatusBadge status={i.status} />
              <span className="text-xs font-normal text-muted-foreground">
                <LocalTime value={i.updatedAt} kind="relative" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {list.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
