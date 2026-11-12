'use client';
import Link from 'next/link';
import { memo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { TicketDto } from '@helpdesk/shared';
import { PriorityBadge, StatusBadge } from '@/entities/ticket/ui/badges';
import { SlaCountdown } from '@/features/ticket-sidebar/ui/ticket-sidebar';
import { cn } from '@/shared/lib/cn';
import { useNow } from '@/shared/lib/use-now';
import { Checkbox } from '@/shared/ui/select';
import { LocalTime } from '@/shared/ui/local-time';

type RowProps = {
  ticket: TicketDto;
  selected: boolean;
  current: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
};

/**
 * One row. Memoised on the ticket OBJECT: a live update replaces only the changed ticket, so every other row keeps its
 * identity — it is not re-rendered, scroll position and the user's selection are untouched.
 */
const Row = memo(({ ticket: tk, selected, current, onToggle, onOpen }: RowProps) => {
  const t = useTranslations();
  const now = useNow();
  const due = tk.sla?.dueAt ?? null;
  const overdue = due !== null && now > 0 && new Date(due).getTime() < now;
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);
  return (
    <tr
      ref={ref}
      data-id={tk.id}
      aria-current={current ? 'true' : undefined}
      aria-selected={selected}
      onDoubleClick={() => onOpen(tk.id)}
      className={cn(
        'border-b border-border align-top',
        current && 'outline outline-2 -outline-offset-2 outline-ring',
        overdue && 'bg-destructive/10',
        selected && 'bg-accent',
      )}
    >
      <td className="p-2">
        <Checkbox
          checked={selected}
          onChange={() => onToggle(tk.id)}
          aria-label={t('queue.selectRow', { code: tk.code })}
        />
      </td>
      <td className="p-2 font-mono text-sm">{tk.code}</td>
      <td className="max-w-md p-2">
        <Link
          href={`/tickets/${tk.id}`}
          className="font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {tk.subject}
        </Link>
        <div className="text-xs text-muted-foreground">
          {tk.customer.name} · {t(`category.${tk.category}`)}
        </div>
      </td>
      <td className="p-2">
        <PriorityBadge priority={tk.priority} />
      </td>
      <td className="p-2">
        <StatusBadge status={tk.status} />
      </td>
      <td className="p-2 text-sm">
        {tk.assignee ? (
          tk.assignee.name
        ) : (
          <span className="text-muted-foreground">{t('ticket.unassigned')}</span>
        )}
      </td>
      <td className="p-2 text-sm" data-testid="sla-cell">
        {tk.sla?.pausedAt ? (
          t('queue.sla.paused')
        ) : due ? (
          <SlaCountdown dueAt={due} />
        ) : (
          t('queue.sla.none')
        )}
        {tk.sla?.breached ? (
          <span
            className="ml-1 font-semibold text-destructive"
            aria-label={t('staff.sidebar.slaBreached')}
          >
            !
          </span>
        ) : null}
      </td>
      <td className="p-2 text-xs text-muted-foreground">
        <LocalTime value={tk.updatedAt} kind="relative" />
      </td>
    </tr>
  );
});
Row.displayName = 'TicketRow';

export const TicketTable = ({
  items,
  selected,
  currentIndex,
  onToggle,
  onToggleAll,
  onOpen,
}: {
  items: readonly TicketDto[];
  selected: ReadonlySet<string>;
  currentIndex: number;
  onToggle: (id: string) => void;
  onToggleAll: (all: boolean) => void;
  onOpen: (id: string) => void;
}) => {
  const t = useTranslations();
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[56rem] border-collapse text-left">
        <caption className="sr-only">{t('queue.title')}</caption>
        <thead className="border-b border-border bg-muted text-sm">
          <tr>
            <th scope="col" className="p-2">
              <Checkbox
                checked={allSelected}
                onChange={() => onToggleAll(!allSelected)}
                aria-label={t('queue.selectAll')}
              />
            </th>
            <th scope="col" className="p-2">
              {t('ticket.number')}
            </th>
            <th scope="col" className="p-2">
              {t('ticket.subject')}
            </th>
            <th scope="col" className="p-2">
              {t('ticket.priority')}
            </th>
            <th scope="col" className="p-2">
              {t('ticket.status')}
            </th>
            <th scope="col" className="p-2">
              {t('ticket.assignee')}
            </th>
            <th scope="col" className="p-2">
              {t('queue.columns.sla')}
            </th>
            <th scope="col" className="p-2">
              {t('ticket.updated')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((tk, i) => (
            <Row
              key={tk.id}
              ticket={tk}
              selected={selected.has(tk.id)}
              current={i === currentIndex}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};
