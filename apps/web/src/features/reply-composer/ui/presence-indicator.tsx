'use client';
import { useTranslations } from 'next-intl';
import { usePresence } from '@/entities/agent/api/staff';

/** "Now replying: Ivan" — colleagues typing in this ticket. Refreshed by SSE events and a short poll so stale entries expire. */
export const PresenceIndicator = ({ ticketId }: { ticketId: string }) => {
  const t = useTranslations('staff.presence');
  const { data } = usePresence(ticketId);
  const names = (data ?? []).map((p) => p.name);
  return (
    <p
      role="status"
      aria-live="polite"
      className="min-h-5 text-sm text-muted-foreground"
      data-testid="presence"
    >
      {names.length > 0 ? t(names.length === 1 ? 'one' : 'many', { names: names.join(', ') }) : ''}
    </p>
  );
};
