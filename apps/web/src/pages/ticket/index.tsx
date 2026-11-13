'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { Me, TicketDetail } from '@helpdesk/shared';
import { useAgents } from '@/entities/agent/api/staff';
import { useMe } from '@/entities/session/api/session';
import {
  ticketKeys,
  useMarkRead,
  usePatchTicket,
  useTicketDetail,
} from '@/entities/ticket/api/tickets';
import { PriorityBadge, StatusBadge } from '@/entities/ticket/ui/badges';
import { RatingForm } from '@/features/rate-ticket/ui/rating-form';
import { PresenceIndicator } from '@/features/reply-composer/ui/presence-indicator';
import { ReplyComposer } from '@/features/reply-composer/ui/reply-composer';
import { TicketSidebar } from '@/features/ticket-sidebar/ui/ticket-sidebar';
import { isApiError } from '@/shared/api/client';
import { describeError } from '@/shared/lib/error-message';
import { useAnnounce } from '@/shared/ui/announcer';
import { Alert } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { TicketThread } from '@/widgets/ticket-thread/ui/ticket-thread';

const SolvedButton = ({ detail }: { detail: TicketDetail }) => {
  const t = useTranslations('ticket.solved');
  const patch = usePatchTicket(detail.ticket.id);
  const announce = useAnnounce();
  const tr = useTranslations();
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  return (
    <div className="grid justify-items-start gap-2">
      <Button
        variant="outline"
        disabled={patch.isPending}
        onClick={async () => {
          setError(null);
          try {
            await patch.mutateAsync({ version: detail.ticket.version, status: 'resolved' });
            announce(t('done'));
          } catch (e) {
            // the page held a stale version: reload the ticket so the NEXT click is sent with the current one
            if (isApiError(e) && e.info.code === 'version_conflict')
              void qc.invalidateQueries({ queryKey: ticketKeys.detail(detail.ticket.id) });
            // visible, not only spoken (the Alert is announced to screen readers too)
            setError(
              isApiError(e)
                ? describeError((k, v) => tr(`errors.${k}`, v), e.info)
                : tr('errors.unknown'),
            );
          }
        }}
      >
        {t('button')}
      </Button>
      {error ? <Alert data-testid="solved-error">{error}</Alert> : null}
    </div>
  );
};

const CustomerView = ({ detail, me }: { detail: TicketDetail; me: Me }) => {
  const t = useTranslations();
  const router = useRouter();
  const markRead = useMarkRead(detail.ticket.id);
  const marked = useRef(false);
  useEffect(() => {
    if (detail.ticket.unread && !marked.current) {
      marked.current = true;
      markRead.mutate();
    }
  }, [detail.ticket.unread, markRead]);
  const tk = detail.ticket;
  const open = tk.status === 'new' || tk.status === 'open' || tk.status === 'pending';
  return (
    <div className="grid max-w-3xl gap-5">
      <TicketThread
        messages={detail.messages}
        events={[]}
        meId={me.id}
        role="customer"
        code={tk.code}
      />
      {open ? (
        <div>
          <SolvedButton detail={detail} />
        </div>
      ) : null}
      {tk.status === 'resolved' || tk.status === 'closed' ? (
        <RatingForm ticketId={tk.id} existing={detail.rating} />
      ) : null}
      {tk.status === 'closed' ? (
        <p className="text-sm text-muted-foreground">{t('ticket.detail.closedNote')}</p>
      ) : null}
      <ReplyComposer
        ticketId={tk.id}
        ticketCode={tk.code}
        customerName={me.name}
        meId={me.id}
        role="customer"
        onSent={(r) => {
          if (r.spawnedFrom) router.push(`/tickets/${r.ticketId}`);
        }}
      />
    </div>
  );
};

const StaffView = ({ detail, me }: { detail: TicketDetail; me: Me }) => {
  const agents = useAgents();
  const tk = detail.ticket;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid content-start gap-4">
        <TicketThread
          messages={detail.messages}
          events={detail.events}
          meId={me.id}
          role={me.role}
          code={tk.code}
        />
        <PresenceIndicator ticketId={tk.id} />
        {tk.status === 'closed' ? (
          <p className="text-sm text-muted-foreground">
            {/* staff cannot reply to closed tickets */}
          </p>
        ) : (
          <ReplyComposer
            ticketId={tk.id}
            ticketCode={tk.code}
            customerName={tk.customer.name}
            meId={me.id}
            role={me.role}
          />
        )}
      </div>
      <TicketSidebar ticket={tk} role={me.role} meId={me.id} agents={agents.data ?? []} />
    </div>
  );
};

export const TicketPage = ({ id }: { id: string }) => {
  const t = useTranslations();
  const me = useMe().data;
  const q = useTicketDetail(id);
  useEffect(() => {
    if (q.data) document.title = `${q.data.ticket.code} · ${q.data.ticket.subject}`;
  }, [q.data]);
  if (q.isPending || !me)
    return (
      <p role="status" className="text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  if (q.isError) {
    return (
      <div className="grid justify-items-start gap-3">
        <Alert>
          {isApiError(q.error)
            ? describeError((k, v) => t(`errors.${k}`, v), q.error.info)
            : t('errors.unknown')}
        </Alert>
        <Button asChild variant="outline">
          <Link href={me.role === 'customer' ? '/tickets' : '/queue'}>{t('common.back')}</Link>
        </Button>
      </div>
    );
  }
  const tk = q.data.ticket;
  return (
    <article aria-labelledby="page-title" className="grid gap-4">
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-muted-foreground">{tk.code}</span>
          <StatusBadge status={tk.status} />
          {me.role !== 'customer' ? <PriorityBadge priority={tk.priority} /> : null}
        </div>
        <h1 id="page-title" className="text-2xl font-semibold">
          {tk.subject}
        </h1>
        {tk.linkedTicketId ? (
          <p className="text-sm">
            <Link className="underline" href={`/tickets/${tk.linkedTicketId}`}>
              {t('ticket.detail.linkedFrom')}
            </Link>
          </p>
        ) : null}
      </header>
      {me.role === 'customer' ? (
        <CustomerView detail={q.data} me={me} />
      ) : (
        <StaffView detail={q.data} me={me} />
      )}
    </article>
  );
};
