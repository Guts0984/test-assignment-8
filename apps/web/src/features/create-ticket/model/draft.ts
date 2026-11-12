import { CATEGORIES, CUSTOMER_PRIORITIES, type Category } from '@helpdesk/shared';

export type NewTicketDraft = {
  subject: string;
  category: Category;
  priority: 'low' | 'normal' | 'high';
  body: string;
  clientMessageId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Accepts whatever an older/corrupt draft contains and returns a safe draft (or null if it is empty). */
export const parseNewTicketDraft = (raw: unknown): NewTicketDraft | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const draft: NewTicketDraft = {
    subject: str(r.subject, 200),
    body: str(r.body, 20_000),
    category: (CATEGORIES as readonly unknown[]).includes(r.category)
      ? (r.category as Category)
      : 'other',
    priority: (CUSTOMER_PRIORITIES as readonly unknown[]).includes(r.priority)
      ? (r.priority as NewTicketDraft['priority'])
      : 'normal',
    clientMessageId:
      typeof r.clientMessageId === 'string' && UUID.test(r.clientMessageId)
        ? r.clientMessageId
        : crypto.randomUUID(),
  };
  return draft.subject.trim() === '' && draft.body.trim() === '' ? null : draft;
};

export const draftKey = (userId: string): string => `new-ticket:${userId}`;
