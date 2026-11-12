import { describe, expect, it, vi } from 'vitest';
import { connectEventStream, type StreamStatus } from './event-stream';

type FakeSource = ReturnType<typeof makeFakeSource>;
const makeFakeSource = () => {
  const listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
  const source = {
    readyState: 0,
    onopen: null as ((e: Event) => void) | null,
    onerror: null as ((e: Event) => void) | null,
    closed: false,
    addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    close() {
      source.closed = true;
      source.readyState = 2;
    },
    emit(type: string, data: string, lastEventId = '') {
      for (const fn of listeners.get(type) ?? []) fn({ data, lastEventId } as MessageEvent<string>);
    },
  };
  return source;
};
const setup = () => {
  const source: FakeSource = makeFakeSource();
  const events: Array<[unknown, string | null]> = [];
  const statuses: StreamStatus[] = [];
  const close = connectEventStream(
    '/api/events',
    { onEvent: (e, id) => events.push([e, id]), onStatus: (s) => statuses.push(s) },
    () => source,
  );
  return { source, events, statuses, close };
};
const tid = '00000000-0000-4000-8000-000000000001';

describe('connectEventStream', () => {
  it('delivers well-formed events with their id, for every event type', () => {
    const { source, events } = setup();
    source.emit('ticket.created', JSON.stringify({ type: 'ticket.created', ticketId: tid }), '5');
    source.emit(
      'ticket.changed',
      JSON.stringify({ type: 'ticket.changed', ticketId: tid, version: 3, changed: ['status'] }),
      '6',
    );
    source.emit(
      'ticket.changed',
      JSON.stringify({ type: 'ticket.changed', ticketId: tid, changed: ['sla'] }),
      '7',
    ); // no version (SLA marks)
    source.emit(
      'message.created',
      JSON.stringify({ type: 'message.created', ticketId: tid, messageId: tid, kind: 'public' }),
      '8',
    );
    source.emit(
      'presence',
      JSON.stringify({ type: 'presence', ticketId: tid, userId: tid, name: 'Іван', typing: true }),
      '9',
    );
    source.emit(
      'notification.created',
      JSON.stringify({
        type: 'notification.created',
        notificationId: tid,
        kind: 'assigned',
        ticketId: tid,
        number: 'HD-1',
      }),
      '10',
    );
    expect(events.map(([e, id]) => [(e as { type: string }).type, id])).toEqual([
      ['ticket.created', '5'],
      ['ticket.changed', '6'],
      ['ticket.changed', '7'],
      ['message.created', '8'],
      ['presence', '9'],
      ['notification.created', '10'],
    ]);
  });

  it.each([
    ['not JSON', '{oops'],
    ['empty', ''],
    ['JSON null', 'null'],
    ['wrong shape', JSON.stringify({ type: 'ticket.created' })],
    ['unknown extra type', JSON.stringify({ type: 'admin.shutdown', ticketId: tid })],
    [
      'type does not match the SSE event name',
      JSON.stringify({ type: 'ticket.created', ticketId: tid }),
    ],
    ['bad uuid', JSON.stringify({ type: 'ticket.created', ticketId: 'nope' })],
    [
      'prototype pollution attempt',
      '{"__proto__":{"x":1},"type":"ticket.created","ticketId":"' + tid + '"}',
    ],
  ])('drops a malformed frame (%s) without throwing', (_n, data) => {
    const { source, events } = setup();
    const name = _n.includes('does not match') ? 'message.created' : 'ticket.created';
    expect(() => source.emit(name, data)).not.toThrow();
    // the one case that IS valid for its name is the prototype-pollution payload (extra keys are ignored by the schema)
    expect(events.length).toBe(_n === 'prototype pollution attempt' ? 1 : 0);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('reports connecting → open → reconnecting → open, and closed when the server gives up (e.g. 401)', () => {
    const { source, statuses } = setup();
    source.readyState = 1;
    source.onopen?.(new Event('open'));
    source.readyState = 0;
    source.onerror?.(new Event('error')); // browser is retrying
    source.readyState = 1;
    source.onopen?.(new Event('open'));
    source.readyState = 2;
    source.onerror?.(new Event('error')); // permanent failure
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open', 'closed']);
  });

  it('the returned function closes the source and reports closed (no leak on unmount)', () => {
    const { source, statuses, close } = setup();
    close();
    expect(source.closed).toBe(true);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('a throwing handler does not break later events', () => {
    const source: FakeSource = makeFakeSource();
    const seen: string[] = [];
    connectEventStream(
      '/x',
      {
        onEvent: (e) => {
          seen.push(e.type);
          if (seen.length === 1) throw new Error('boom');
        },
      },
      () => source,
    );
    const ev = JSON.stringify({ type: 'ticket.created', ticketId: tid });
    expect(() => source.emit('ticket.created', ev)).toThrow(); // the handler's own error surfaces to the caller…
    source.emit('ticket.created', ev); // …and the stream keeps delivering
    expect(seen).toHaveLength(2);
    vi.restoreAllMocks();
  });
});
