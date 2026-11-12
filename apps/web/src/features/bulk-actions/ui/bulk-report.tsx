'use client';
import { useTranslations } from 'next-intl';
import type { TicketDto } from '@helpdesk/shared';
import { Button } from '@/shared/ui/button';
import type { BulkReport } from '../model/bulk';

/** The outcome of a bulk action: how many were applied and, for every skipped ticket, the reason. Outlives the selection. */
export const BulkReportPanel = ({
  report,
  tickets,
  onDismiss,
}: {
  report: BulkReport;
  tickets: readonly TicketDto[];
  onDismiss: () => void;
}) => {
  const t = useTranslations('queue.bulk');
  const tc = useTranslations('common');
  const find = (id: string) => tickets.find((x) => x.id === id);
  return (
    <div
      role="status"
      data-testid="bulk-report"
      className="grid gap-2 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <div className="flex items-center gap-3">
        <p className="font-semibold">
          {t('report', { ok: report.ok.length, skipped: report.skipped.length })}
        </p>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onDismiss}>
          {tc('dismiss')}
        </Button>
      </div>
      {report.skipped.length > 0 ? (
        <>
          <p className="font-medium">{t('skippedTitle')}</p>
          <ul className="grid gap-1">
            {report.skipped.map((s) => (
              <li key={s.id} className="flex flex-wrap gap-2">
                <span className="font-mono">{find(s.id)?.code ?? s.id.slice(0, 8)}</span>
                <span className="truncate">{find(s.id)?.subject}</span>
                <span className="text-muted-foreground">— {t(`reason.${s.reason}`)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
};
