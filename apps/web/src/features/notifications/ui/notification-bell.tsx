'use client';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { useMarkNotificationsRead, useNotifications } from '@/entities/agent/api/staff';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { LocalTime } from '@/shared/ui/local-time';

/** Bell with an unread counter; the panel lists notifications, each a link to its ticket. Esc closes, focus returns to the bell. */
export const NotificationBell = () => {
  const t = useTranslations('staff.notifications');
  const { data } = useNotifications();
  const mark = useMarkNotificationsRead();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const unread = data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const unreadIds = data?.items.filter((n) => !n.readAt).map((n) => n.id) ?? [];
  return (
    <div className="relative">
      <Button
        ref={button}
        variant="outline"
        size="icon"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="notif-panel"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${t('title')}: ${t('bell', { count: unread })}`}
        className="relative"
      >
        <Bell aria-hidden="true" />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            data-testid="bell-count"
            className="absolute -right-1 -top-1 min-w-5 rounded-full bg-destructive px-1 text-center text-xs font-bold text-destructive-foreground"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div
          id="notif-panel"
          ref={panel}
          role="region"
          aria-label={t('title')}
          className="absolute right-0 z-40 mt-2 w-80 rounded-lg border border-border bg-card p-2 shadow-lg"
        >
          <div className="flex items-center justify-between px-2 py-1">
            <h2 className="text-sm font-semibold">{t('title')}</h2>
            {unreadIds.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => mark.mutate(unreadIds)}>
                {t('markAll')}
              </Button>
            ) : null}
          </div>
          {data && data.items.length > 0 ? (
            <ul className="max-h-96 overflow-auto">
              {data.items.map((n) => (
                <li key={n.id}>
                  <Link
                    href={`/tickets/${n.ticket.id}`}
                    onClick={() => {
                      setOpen(false);
                      if (!n.readAt) mark.mutate([n.id]);
                    }}
                    className={cn(
                      'block rounded-md px-2 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      !n.readAt && 'font-semibold',
                    )}
                  >
                    <span>{t(n.type, { code: n.ticket.code })}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {n.ticket.subject}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      <LocalTime value={n.createdAt} kind="relative" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 py-3 text-sm text-muted-foreground">{t('none')}</p>
          )}
        </div>
      ) : null}
    </div>
  );
};
