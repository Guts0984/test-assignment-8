'use client';
import { useTranslations } from 'next-intl';
import type { Priority, TicketStatus } from '@helpdesk/shared';
import { cn } from '@/shared/lib/cn';
import { Badge } from '@/shared/ui/badge';

const STATUS_STYLE: Record<TicketStatus, string> = {
  new: 'border-transparent bg-primary text-primary-foreground',
  open: 'border-transparent bg-secondary text-secondary-foreground',
  pending: 'border-amber-600 text-amber-800 dark:border-amber-400 dark:text-amber-300',
  resolved: 'border-emerald-700 text-emerald-800 dark:border-emerald-400 dark:text-emerald-300',
  closed: 'border-border text-muted-foreground',
};
const PRIORITY_STYLE: Record<Priority, string> = {
  low: 'border-border text-muted-foreground',
  normal: 'border-border text-foreground',
  high: 'border-amber-600 text-amber-800 dark:border-amber-400 dark:text-amber-300',
  urgent: 'border-transparent bg-destructive text-destructive-foreground',
};

export const StatusBadge = ({ status }: { status: TicketStatus }) => {
  const t = useTranslations('status');
  return (
    <Badge variant="outline" className={cn(STATUS_STYLE[status])}>
      {t(status)}
    </Badge>
  );
};
export const PriorityBadge = ({ priority }: { priority: Priority }) => {
  const t = useTranslations('priority');
  return (
    <Badge variant="outline" className={cn(PRIORITY_STYLE[priority])}>
      {t(priority)}
    </Badge>
  );
};
