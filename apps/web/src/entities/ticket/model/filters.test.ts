import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_VIEWS,
  DEFAULT_FILTERS,
  parseFilters,
  serializeFilters,
  ticketMatches,
  toApiQuery,
  type TicketFilters,
} from './filters';

const parse = (qs: string) => parseFilters(new URLSearchParams(qs));
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('filters ⇄ URL (acceptance #13: reload and Back restore the state)', () => {
  it('the default view has an empty query string', () => {
    expect(serializeFilters(DEFAULT_FILTERS)).toBe('');
    expect(parse('')).toEqual(DEFAULT_FILTERS);
  });
  it('round-trips every filter', () => {
    const f: TicketFilters = {
      status: ['open', 'pending'],
      priority: ['high', 'urgent'],
      category: ['payment'],
      assignee: OTHER,
      slaBreached: true,
      tags: ['vip', 'refund'],
      createdFrom: '2026-10-01T00:00:00.000Z',
      createdTo: '2026-10-31T23:59:59.000Z',
      q: 'не платить',
      sort: 'sla',
      order: 'asc',
    };
    expect(parse(serializeFilters(f))).toEqual(f);
  });
  it('round-trips the special assignees and slaBreached=false', () => {
    for (const assignee of ['me', 'none'] as const)
      expect(parse(serializeFilters({ ...DEFAULT_FILTERS, assignee })).assignee).toBe(assignee);
    expect(parse(serializeFilters({ ...DEFAULT_FILTERS, slaBreached: false })).slaBreached).toBe(
      false,
    );
  });
  it.each([
    [
      'unknown status values are dropped, valid ones kept',
      'status=open,bogus,pending',
      (f: TicketFilters) => expect(f.status).toEqual(['open', 'pending']),
    ],
    [
      'a made-up assignee is ignored',
      'assignee=someone',
      (f: TicketFilters) => expect(f.assignee).toBeNull(),
    ],
    [
      'SQL / script in a param is just text or ignored',
      "status='; DROP TABLE--&category=<script>",
      (f: TicketFilters) => expect([f.status, f.category]).toEqual([[], []]),
    ],
    [
      'bad sort/order fall back to defaults',
      'sort=password&order=sideways',
      (f: TicketFilters) => expect([f.sort, f.order]).toEqual(['created', 'desc']),
    ],
    [
      'garbage dates are ignored',
      'createdFrom=yesterday&createdTo=2026-13-45',
      (f: TicketFilters) => expect([f.createdFrom, f.createdTo]).toEqual([null, null]),
    ],
    [
      'an over-long search is cut to 200 characters',
      `q=${'a'.repeat(500)}`,
      (f: TicketFilters) => expect(f.q).toHaveLength(200),
    ],
    [
      'tags are lower-cased, trimmed, capped at 20',
      `tags=${Array.from({ length: 30 }, (_, i) => `T${i}`).join(',')}`,
      (f: TicketFilters) => expect(f.tags).toHaveLength(20),
    ],
    [
      'slaBreached only accepts true/false',
      'slaBreached=maybe',
      (f: TicketFilters) => expect(f.slaBreached).toBeNull(),
    ],
  ])('%s', (_n, qs, check) => check(parse(qs)));
  it('serialisation output is always safe to put in a URL (special characters are encoded)', () => {
    const s = serializeFilters({ ...DEFAULT_FILTERS, q: 'a&b=c #d' });
    expect(s).toBe('q=a%26b%3Dc+%23d');
    expect(parse(s).q).toBe('a&b=c #d');
  });
  it('toApiQuery uses the API names and omits empty filters', () => {
    expect(
      toApiQuery({ ...DEFAULT_FILTERS, status: ['open'], assignee: 'me', q: '  hi ' }),
    ).toMatchObject({ status: ['open'], assignee: 'me', q: 'hi', sort: 'created', order: 'desc' });
    const q = toApiQuery(DEFAULT_FILTERS);
    expect(q).not.toHaveProperty('assignee');
    expect(q).not.toHaveProperty('q');
    expect(q).not.toHaveProperty('slaBreached');
  });
});

describe('ticketMatches (where a live update belongs)', () => {
  const t = {
    status: 'open',
    priority: 'high',
    category: 'payment',
    assignee: { id: ME },
    tags: ['vip'],
    createdAt: '2026-10-15T10:00:00Z',
    sla: { breached: false },
  };
  it('empty filters match everything', () =>
    expect(ticketMatches(DEFAULT_FILTERS, t, ME)).toBe(true));
  it('each filter excludes what it should', () => {
    expect(ticketMatches({ ...DEFAULT_FILTERS, status: ['closed'] }, t, ME)).toBe(false);
    expect(ticketMatches({ ...DEFAULT_FILTERS, priority: ['low'] }, t, ME)).toBe(false);
    expect(ticketMatches({ ...DEFAULT_FILTERS, category: ['delivery'] }, t, ME)).toBe(false);
    expect(ticketMatches({ ...DEFAULT_FILTERS, assignee: 'none' }, t, ME)).toBe(false);
    expect(ticketMatches({ ...DEFAULT_FILTERS, assignee: 'me' }, t, OTHER)).toBe(false);
    expect(ticketMatches({ ...DEFAULT_FILTERS, assignee: 'me' }, t, ME)).toBe(true);
    expect(ticketMatches({ ...DEFAULT_FILTERS, slaBreached: true }, t, ME)).toBe(false);
    expect(ticketMatches({ ...DEFAULT_FILTERS, tags: ['vip', 'refund'] }, t, ME)).toBe(false);
    expect(ticketMatches({ ...DEFAULT_FILTERS, createdFrom: '2026-10-16T00:00:00Z' }, t, ME)).toBe(
      false,
    );
    expect(ticketMatches({ ...DEFAULT_FILTERS, createdTo: '2026-10-14T00:00:00Z' }, t, ME)).toBe(
      false,
    );
  });
  it('an unassigned ticket matches "none" but not "me"', () => {
    const free = { ...t, assignee: null };
    expect(ticketMatches({ ...DEFAULT_FILTERS, assignee: 'none' }, free, ME)).toBe(true);
    expect(ticketMatches({ ...DEFAULT_FILTERS, assignee: 'me' }, free, ME)).toBe(false);
  });
  it('built-in views are valid filters', () => {
    expect(BUILT_IN_VIEWS.map((v) => v.id)).toEqual(['my-open', 'unassigned', 'sla-burning']);
    for (const v of BUILT_IN_VIEWS)
      expect(parse(serializeFilters({ ...DEFAULT_FILTERS, ...v.filters }))).toEqual({
        ...DEFAULT_FILTERS,
        ...v.filters,
      });
  });
});
