import { describe, expect, it } from 'vitest';
import {
  bulkRequestSchema,
  createMessageSchema,
  createTicketSchema,
  listTicketsQuerySchema,
  loginSchema,
  patchTicketSchema,
  ratingSchema,
  slaSettingsSchema,
  statsQuerySchema,
  staffCreateTicketSchema,
} from '../src';

const uuid = () => crypto.randomUUID();
const validTicket = () => ({
  subject: 'Cannot pay',
  category: 'payment',
  priority: 'high',
  body: 'help',
  clientMessageId: uuid(),
});

describe('createTicketSchema', () => {
  it('accepts a valid ticket and defaults priority/attachments', () => {
    const r = createTicketSchema.parse({ ...validTicket(), priority: undefined });
    expect(r.priority).toBe('normal');
    expect(r.attachmentIds).toEqual([]);
  });
  it.each([
    ['empty subject', { subject: '' }],
    ['whitespace subject', { subject: '   \t ' }],
    ['201-char subject', { subject: 'a'.repeat(201) }],
    ['NUL in subject', { subject: 'a\u0000b' }],
    ['NUL in body', { body: 'a\u0000b' }],
    ['blank body', { body: '   ' }],
    ['body over limit', { body: 'x'.repeat(20_001) }],
    ['unknown category', { category: 'billing' }],
    ['non-string subject', { subject: 123 }],
    ['array subject', { subject: ['a'] }],
    ['object subject', { subject: { $ne: '' } }],
    ['bad message id', { clientMessageId: 'not-a-uuid' }],
    ['6 attachments', { attachmentIds: Array.from({ length: 6 }, uuid) }],
    ['non-uuid attachment', { attachmentIds: ['../../etc/passwd'] }],
  ])('rejects %s', (_n, patch) => {
    expect(createTicketSchema.safeParse({ ...validTicket(), ...patch }).success).toBe(false);
  });
  it('accepts boundary subject lengths 1 and 200 (unicode counted per code unit)', () => {
    expect(createTicketSchema.safeParse({ ...validTicket(), subject: 'a' }).success).toBe(true);
    expect(
      createTicketSchema.safeParse({ ...validTicket(), subject: 'я'.repeat(200) }).success,
    ).toBe(true);
  });
  it('trims the subject', () => {
    expect(createTicketSchema.parse({ ...validTicket(), subject: '  hi  ' }).subject).toBe('hi');
  });
  it('customers may NOT set urgent; staff schema may', () => {
    expect(createTicketSchema.safeParse({ ...validTicket(), priority: 'urgent' }).success).toBe(
      false,
    );
    expect(
      staffCreateTicketSchema.safeParse({ ...validTicket(), priority: 'urgent' }).success,
    ).toBe(true);
  });
  it('rejects mass-assignment of privileged fields (strict)', () => {
    for (const extra of [
      { status: 'resolved' },
      { assigneeId: uuid() },
      { role: 'lead' },
      { number: 'HD-1' },
      { customerId: uuid() },
    ])
      expect(createTicketSchema.safeParse({ ...validTicket(), ...extra }).success).toBe(false);
  });
  it('rejects prototype pollution payloads (JSON.parse creates an own __proto__ key)', () => {
    const polluted = JSON.parse(
      '{"__proto__":{"isAdmin":true},"subject":"x","category":"other","body":"b","clientMessageId":"' +
        uuid() +
        '"}',
    );
    expect(createTicketSchema.safeParse(polluted).success).toBe(false);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });
});

describe('patchTicketSchema', () => {
  it('requires version and at least one change', () => {
    expect(patchTicketSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(patchTicketSchema.safeParse({ status: 'open' }).success).toBe(false);
    expect(patchTicketSchema.safeParse({ version: 1, status: 'open' }).success).toBe(true);
  });
  it.each([0, -1, 1.5, '1', null, Number.NaN, Infinity])('rejects version %s', (version) => {
    expect(patchTicketSchema.safeParse({ version, status: 'open' }).success).toBe(false);
  });
  it('allows unassigning with null, distinguishes it from omitted', () => {
    expect(patchTicketSchema.parse({ version: 1, assigneeId: null }).assigneeId).toBeNull();
    expect(patchTicketSchema.parse({ version: 1, status: 'open' }).assigneeId).toBeUndefined();
  });
  it('normalizes and dedupes tags, caps count and length', () => {
    expect(patchTicketSchema.parse({ version: 1, tags: [' VIP ', 'vip', 'Refund'] }).tags).toEqual([
      'vip',
      'refund',
    ]);
    expect(
      patchTicketSchema.safeParse({
        version: 1,
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
    expect(patchTicketSchema.safeParse({ version: 1, tags: ['x'.repeat(41)] }).success).toBe(false);
    expect(patchTicketSchema.safeParse({ version: 1, tags: [''] }).success).toBe(false);
  });
  it('rejects unknown keys such as id/number/createdAt', () => {
    for (const extra of [
      { id: uuid() },
      { number: 'HD-1' },
      { createdAt: new Date().toISOString() },
      { slaDue: 'x' },
    ])
      expect(patchTicketSchema.safeParse({ version: 1, status: 'open', ...extra }).success).toBe(
        false,
      );
  });
});

describe('createMessageSchema', () => {
  const base = () => ({ id: uuid(), body: 'hello' });
  it('defaults to a public message', () => {
    expect(createMessageSchema.parse(base()).kind).toBe('public');
  });
  it('requires a client-generated uuid', () => {
    expect(createMessageSchema.safeParse({ body: 'x' }).success).toBe(false);
    expect(createMessageSchema.safeParse({ id: 'abc', body: 'x' }).success).toBe(false);
  });
  it('rejects an internal note that tries to change status', () => {
    expect(
      createMessageSchema.safeParse({ ...base(), kind: 'internal', setStatus: 'resolved' }).success,
    ).toBe(false);
    expect(
      createMessageSchema.safeParse({ ...base(), kind: 'public', setStatus: 'resolved' }).success,
    ).toBe(true);
  });
  it('setStatus is limited to pending/resolved', () => {
    for (const s of ['closed', 'new', 'open'])
      expect(createMessageSchema.safeParse({ ...base(), setStatus: s }).success).toBe(false);
  });
  it('rejects kind injection', () => {
    expect(createMessageSchema.safeParse({ ...base(), kind: 'system' }).success).toBe(false);
  });
});

describe('listTicketsQuerySchema', () => {
  it('applies defaults', () => {
    const q = listTicketsQuerySchema.parse({});
    expect(q).toMatchObject({ sort: 'created', order: 'desc', limit: 50 });
  });
  it('parses csv and repeated params', () => {
    expect(listTicketsQuerySchema.parse({ status: 'open,pending' }).status).toEqual([
      'open',
      'pending',
    ]);
    expect(listTicketsQuerySchema.parse({ status: ['open', 'new'] }).status).toEqual([
      'open',
      'new',
    ]);
  });
  it.each([
    ['bad status', { status: 'open,bogus' }],
    ['limit 0', { limit: '0' }],
    ['limit 101', { limit: '101' }],
    ['limit NaN', { limit: 'abc' }],
    ['negative limit', { limit: '-5' }],
    ['sort injection', { sort: 'created; DROP TABLE tickets' }],
    ['order injection', { order: 'asc,id' }],
    ['inverted period', { createdFrom: '2026-02-01T00:00:00Z', createdTo: '2026-01-01T00:00:00Z' }],
    ['non-iso date', { createdFrom: 'yesterday' }],
    ['huge query', { q: 'a'.repeat(201) }],
    ['huge cursor', { cursor: 'a'.repeat(513) }],
    ['bad assignee', { assignee: 'someone' }],
    ['bad slaBreached', { slaBreached: 'maybe' }],
    ['unknown param', { admin: '1' }],
  ])('rejects %s', (_n, q) => {
    expect(listTicketsQuerySchema.safeParse(q).success).toBe(false);
  });
  it('accepts assignee me / none / uuid and trims q', () => {
    for (const a of ['me', 'none', uuid()])
      expect(listTicketsQuerySchema.safeParse({ assignee: a }).success).toBe(true);
    expect(listTicketsQuerySchema.parse({ q: '  refund  ' }).q).toBe('refund');
    expect(listTicketsQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });
});

describe('bulkRequestSchema', () => {
  const ids = (n: number) => Array.from({ length: n }, uuid);
  const op = { action: 'setStatus', status: 'resolved' };
  it('accepts 1 and 200 ids, rejects 0 and 201', () => {
    expect(bulkRequestSchema.safeParse({ ids: ids(1), operation: op }).success).toBe(true);
    expect(bulkRequestSchema.safeParse({ ids: ids(200), operation: op }).success).toBe(true);
    expect(bulkRequestSchema.safeParse({ ids: [], operation: op }).success).toBe(false);
    expect(bulkRequestSchema.safeParse({ ids: ids(201), operation: op }).success).toBe(false);
  });
  it('rejects duplicate ids', () => {
    const id = uuid();
    expect(bulkRequestSchema.safeParse({ ids: [id, id], operation: op }).success).toBe(false);
  });
  it('rejects unknown actions and mixed-in fields', () => {
    expect(
      bulkRequestSchema.safeParse({ ids: ids(1), operation: { action: 'delete' } }).success,
    ).toBe(false);
    expect(
      bulkRequestSchema.safeParse({ ids: ids(1), operation: { ...op, priority: 'low' } }).success,
    ).toBe(false);
    expect(
      bulkRequestSchema.safeParse({ ids: ids(1), operation: { action: 'assign' } }).success,
    ).toBe(false);
  });
  it('accepts assign to null (unassign) and tag modes', () => {
    expect(
      bulkRequestSchema.safeParse({
        ids: ids(1),
        operation: { action: 'assign', assigneeId: null },
      }).success,
    ).toBe(true);
    expect(
      bulkRequestSchema.safeParse({
        ids: ids(1),
        operation: { action: 'setTags', mode: 'add', tags: ['a'] },
      }).success,
    ).toBe(true);
    expect(
      bulkRequestSchema.safeParse({
        ids: ids(1),
        operation: { action: 'setTags', mode: 'nuke', tags: ['a'] },
      }).success,
    ).toBe(false);
  });
});

describe('loginSchema', () => {
  it('normalizes email and bounds password', () => {
    expect(loginSchema.parse({ email: ' A@B.com ', password: 'x' }).email).toBe('a@b.com');
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'x'.repeat(129) }).success).toBe(
      false,
    ); // hash-DoS guard
    expect(loginSchema.safeParse({ email: { $gt: '' }, password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
  });
});

describe('rating, stats, sla settings', () => {
  it('rating 1..5 integers only', () => {
    for (const score of [1, 5]) expect(ratingSchema.safeParse({ score }).success).toBe(true);
    for (const score of [0, 6, 2.5, '3', null])
      expect(ratingSchema.safeParse({ score }).success).toBe(false);
    expect(ratingSchema.safeParse({ score: 3, comment: 'x'.repeat(2001) }).success).toBe(false);
  });
  it('stats period must be ordered', () => {
    expect(
      statsQuerySchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' })
        .success,
    ).toBe(true);
    expect(
      statsQuerySchema.safeParse({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });
  const pol = (priority: string, f = 60, r = 240) => ({
    priority,
    firstResponseMinutes: f,
    resolutionMinutes: r,
    businessHours: priority !== 'urgent',
  });
  it('sla settings need exactly one policy per priority and sane minutes', () => {
    const ok = ['urgent', 'high', 'normal', 'low'].map((p) => pol(p));
    expect(slaSettingsSchema.safeParse({ policies: ok }).success).toBe(true);
    expect(
      slaSettingsSchema.safeParse({ policies: [...ok.slice(0, 3), pol('high')] }).success,
    ).toBe(false);
    expect(slaSettingsSchema.safeParse({ policies: ok.slice(0, 3) }).success).toBe(false);
    expect(
      slaSettingsSchema.safeParse({ policies: [pol('urgent', 0), ...ok.slice(1)] }).success,
    ).toBe(false);
    expect(
      slaSettingsSchema.safeParse({ policies: [pol('urgent', 120, 60), ...ok.slice(1)] }).success,
    ).toBe(false);
  });
});
