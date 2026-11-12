import type { TicketDto } from '@helpdesk/shared';

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ticket = (n: number, over: Partial<TicketDto> = {}): TicketDto => ({
  id: uid(n),
  number: 1000 + n,
  code: `HD-${1000 + n}`,
  subject: `Subject ${n}`,
  category: 'payment',
  priority: 'normal',
  status: 'open',
  customer: { id: uid(900), name: 'Олена' },
  assignee: null,
  tags: [],
  version: 1,
  linkedTicketId: null,
  createdAt: `2026-11-${String(10 + (n % 15)).padStart(2, '0')}T10:00:00.000Z`,
  updatedAt: `2026-11-${String(10 + (n % 15)).padStart(2, '0')}T10:00:00.000Z`,
  lastPublicMessageAt: null,
  unread: false,
  sla: {
    firstResponseDue: '2027-01-01T10:00:00.000Z',
    resolutionDue: '2027-01-02T10:00:00.000Z',
    firstRespondedAt: null,
    resolvedAt: null,
    dueAt: '2027-01-01T10:00:00.000Z',
    pausedAt: null,
    firstResponseBreached: false,
    resolutionBreached: false,
    breached: false,
  },
  ...over,
});
