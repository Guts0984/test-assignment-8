'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import type { SseEvent } from '@helpdesk/shared';
import { useAnnounce } from '@/shared/ui/announcer';
import { useEventStream } from '../model/use-event-stream';
import { handleLiveEvent } from '../model/live-updates';

/** Mounted once in the shell: keeps every list and open ticket fresh and announces what matters to screen readers. */
export const LiveUpdates = ({
  meId,
  role,
}: {
  meId: string;
  role: 'customer' | 'agent' | 'lead';
}) => {
  const qc = useQueryClient();
  const announce = useAnnounce();
  const t = useTranslations();
  const status = useEventStream((e: SseEvent) => {
    void handleLiveEvent(qc, e, {
      meId,
      announce,
      describe: (ev) => {
        if (ev.type === 'notification.created')
          return t(`staff.notifications.${ev.kind}`, { code: ev.number });
        if (ev.type === 'message.created')
          return role === 'customer' ? t('ticket.list.unreadAnnounce') : null;
        return null;
      },
    });
  });
  useEffect(() => {
    if (status === 'reconnecting') announce(t('live.connectionLost'), 'polite');
  }, [status, announce, t]);
  return null;
};
