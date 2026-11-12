import type { MessageDto, TicketEventDto } from '@helpdesk/shared';
import { describe, expect, it } from 'vitest';
import { uid } from '../../../../test/fixtures';
import { buildTimeline, newForeignMessages } from './timeline';

const m = (n: number, at: string, over: Partial<MessageDto> = {}): MessageDto => ({
  id: uid(n),
  ticketId: uid(1),
  author: { id: uid(900), name: 'A', role: 'agent' },
  kind: 'public',
  body: 'b',
  createdAt: at,
  attachments: [],
  ...over,
});
const e = (id: number, at: string, field: TicketEventDto['field'] = 'status'): TicketEventDto => ({
  id,
  actor: null,
  field,
  oldValue: null,
  newValue: null,
  createdAt: at,
});

describe('buildTimeline', () => {
  it('merges messages, notes and field changes chronologically; drops the "created" event', () => {
    const t = buildTimeline(
      [m(1, '2026-01-01T10:00:00Z'), m(2, '2026-01-01T12:00:00Z', { kind: 'internal' })],
      [e(1, '2026-01-01T10:00:00Z', 'created'), e(2, '2026-01-01T11:00:00Z')],
    );
    expect(
      t.map((i) => (i.kind === 'message' ? `m:${i.message.kind}` : `e:${i.event.field}`)),
    ).toEqual(['m:public', 'e:status', 'm:internal']);
  });
  it('is stable for equal timestamps: the message comes before the change it caused, ties by id', () => {
    const t = buildTimeline(
      [m(2, '2026-01-01T10:00:00Z'), m(1, '2026-01-01T10:00:00Z')],
      [e(5, '2026-01-01T10:00:00Z')],
    );
    expect(t.map((i) => i.kind)).toEqual(['message', 'message', 'event']);
    expect(t.map((i) => (i.kind === 'message' ? i.message.id : ''))).toEqual([uid(1), uid(2), '']);
    expect(
      buildTimeline([m(1, '2026-01-01T10:00:00Z'), m(2, '2026-01-01T10:00:00Z')], []).map(
        (i) => i.id,
      ),
    ).toEqual(
      buildTimeline([m(2, '2026-01-01T10:00:00Z'), m(1, '2026-01-01T10:00:00Z')], []).map(
        (i) => i.id,
      ),
    );
  });
  it('handles empty input', () => expect(buildTimeline([], [])).toEqual([]));
  it('does not mutate its inputs', () => {
    const msgs = Object.freeze([m(1, '2026-01-01T10:00:00Z')]);
    expect(() => buildTimeline(msgs, Object.freeze([e(1, '2026-01-01T09:00:00Z')]))).not.toThrow();
  });
});

describe('newForeignMessages', () => {
  it('returns only messages that are new AND written by somebody else', () => {
    const mine = m(3, '2026-01-01T12:00:00Z', {
      author: { id: uid(500), name: 'me', role: 'agent' },
    });
    const fresh = newForeignMessages(
      new Set([uid(1)]),
      [m(1, '2026-01-01T10:00:00Z'), m(2, '2026-01-01T11:00:00Z'), mine],
      uid(500),
    );
    expect(fresh.map((x) => x.id)).toEqual([uid(2)]);
  });
});
