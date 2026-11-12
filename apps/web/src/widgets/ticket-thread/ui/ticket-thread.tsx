'use client';
import { Lock, Paperclip } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { MessageDto, Role, TicketEventDto } from '@helpdesk/shared';
import { api } from '@/shared/api/client';
import { cn } from '@/shared/lib/cn';
import { useAnnounce } from '@/shared/ui/announcer';
import { LocalTime } from '@/shared/ui/local-time';
import { buildTimeline, newForeignMessages } from '../model/timeline';

const EventLine = ({ event }: { event: TicketEventDto }) => {
  const t = useTranslations();
  const tv = (ns: string, v: string | null) =>
    v ? (t.has(`${ns}.${v}`) ? t(`${ns}.${v}`) : v) : '—';
  const text =
    event.field === 'status'
      ? t('staff.events.status', {
          from: tv('status', event.oldValue),
          to: tv('status', event.newValue),
        })
      : event.field === 'priority'
        ? t('staff.events.priority', {
            from: tv('priority', event.oldValue),
            to: tv('priority', event.newValue),
          })
        : event.field === 'category'
          ? t('staff.events.category', {
              from: tv('category', event.oldValue),
              to: tv('category', event.newValue),
            })
          : event.field === 'tags'
            ? t('staff.events.tags', { to: event.newValue || '—' })
            : event.field === 'assignee'
              ? event.newValue
                ? t('staff.events.assigned', { name: '' }).replace(/\s+$/, '')
                : t('staff.events.unassignedTo')
              : t('staff.events.created');
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 border-l-2 border-border pl-3 text-xs text-muted-foreground">
      <span>{text}</span>
      <span>· {event.actor ? event.actor.name : t('staff.events.system')}</span>
      <LocalTime value={event.createdAt} />
    </li>
  );
};

const Bubble = ({ m, meId }: { m: MessageDto; meId: string }) => {
  const t = useTranslations();
  const note = m.kind === 'internal';
  const mine = m.author.id === meId;
  return (
    <li
      className={cn(
        'rounded-lg border p-3',
        note
          ? 'border-amber-500 bg-amber-100 text-amber-950 dark:border-amber-400 dark:bg-amber-950/40 dark:text-amber-100'
          : mine
            ? 'border-primary/40 bg-accent'
            : 'border-border bg-card',
      )}
      data-kind={m.kind}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
        {note ? (
          <span className="inline-flex items-center gap-1 font-semibold">
            <Lock className="size-3.5" aria-hidden="true" />
            {t('staff.composer.modeNote')}
          </span>
        ) : null}
        <strong>{m.author.name}</strong>
        <span className="text-xs opacity-80">{t(`role.${m.author.role}`)}</span>
        <LocalTime value={m.createdAt} />
      </div>
      <p className="whitespace-pre-wrap break-words">{m.body}</p>
      {m.attachments.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label={t('ticket.detail.attachment')}>
          {m.attachments.map((a) => (
            <li key={a.id}>
              <a
                href={`${api.baseUrl}/attachments/${a.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Paperclip className="size-3.5" aria-hidden="true" />
                {a.name}
                <span className="sr-only">{t('ticket.detail.download')}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
};

/** The conversation. New messages from others are announced to screen readers without moving focus. */
export const TicketThread = ({
  messages,
  events,
  meId,
  role,
  code,
}: {
  messages: readonly MessageDto[];
  events: readonly TicketEventDto[];
  meId: string;
  role: Role;
  code: string;
}) => {
  const t = useTranslations();
  const announce = useAnnounce();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seen.current) {
      const fresh = newForeignMessages(seen.current, messages, meId);
      if (fresh.length > 0) announce(t('live.newMessage', { code }));
    }
    seen.current = new Set(messages.map((m) => m.id));
  }, [messages, meId, announce, t, code]);

  const items = buildTimeline(messages, role === 'customer' ? [] : events);
  if (items.length === 0)
    return <p className="text-muted-foreground">{t('ticket.detail.noMessages')}</p>;
  return (
    <ol className="grid gap-3" aria-label={t('ticket.detail.conversation')}>
      {items.map((i) =>
        i.kind === 'message' ? (
          <Bubble key={i.id} m={i.message} meId={meId} />
        ) : (
          <EventLine key={`e${i.id}`} event={i.event} />
        ),
      )}
    </ol>
  );
};
