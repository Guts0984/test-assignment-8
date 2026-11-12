export type ReplyDraft = { body: string; mode: 'reply' | 'note'; messageId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Per ticket AND per account: replies of one person never show up for another on a shared computer. */
export const replyDraftKey = (userId: string, ticketId: string): string =>
  `reply:${userId}:${ticketId}`;

export const parseReplyDraft = (raw: unknown): ReplyDraft | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const body = typeof r.body === 'string' ? r.body.slice(0, 20_000) : '';
  if (body.trim() === '') return null;
  return {
    body,
    mode: r.mode === 'note' ? 'note' : 'reply',
    messageId:
      typeof r.messageId === 'string' && UUID.test(r.messageId) ? r.messageId : crypto.randomUUID(),
  };
};

/** What the Send button does, as a pure function (also decides the labels and what the customer may see). */
export type SendPlan = { kind: 'public' | 'internal'; setStatus?: 'pending' | 'resolved' };
export const planSend = (mode: 'reply' | 'note', action: 'send' | 'wait' | 'resolve'): SendPlan =>
  mode === 'note'
    ? { kind: 'internal' }
    : action === 'wait'
      ? { kind: 'public', setStatus: 'pending' }
      : action === 'resolve'
        ? { kind: 'public', setStatus: 'resolved' }
        : { kind: 'public' };
