import { sseEventSchema, type SseEvent } from '@helpdesk/shared';

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

type EventSourceLike = {
  readyState: number;
  close: () => void;
  addEventListener: (type: string, listener: (e: MessageEvent<string>) => void) => void;
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
};
export type EventSourceFactory = (url: string) => EventSourceLike;

const browserEventSource: EventSourceFactory = (u) =>
  new EventSource(u, { withCredentials: true }) as unknown as EventSourceLike;

const EVENT_TYPES = [
  'ticket.created',
  'ticket.changed',
  'message.created',
  'notification.created',
  'presence',
] as const;

/**
 * Connects to the server's event stream. Frames are validated against the shared schema — anything malformed or
 * unknown is dropped, never thrown — and the browser's built-in reconnection (with Last-Event-ID) is used, so
 * nothing is missed across a dropped connection. Returns a function that closes the stream.
 */
export const connectEventStream = (
  url: string,
  handlers: {
    onEvent: (e: SseEvent, id: string | null) => void;
    onStatus?: (s: StreamStatus) => void;
  },
  factory: EventSourceFactory = browserEventSource,
): (() => void) => {
  // no EventSource (very old browser, test environment): the app works without live updates, it just does not push
  if (factory === browserEventSource && typeof EventSource === 'undefined') {
    handlers.onStatus?.('closed');
    return () => undefined;
  }
  handlers.onStatus?.('connecting');
  const source = factory(url);
  const CLOSED = 2;
  source.onopen = () => handlers.onStatus?.('open');
  source.onerror = () =>
    handlers.onStatus?.(source.readyState === CLOSED ? 'closed' : 'reconnecting');
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (message) => {
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = sseEventSchema.safeParse(data);
      if (parsed.success && parsed.data.type === type)
        handlers.onEvent(parsed.data, message.lastEventId || null);
    });
  }
  return () => {
    source.close();
    handlers.onStatus?.('closed');
  };
};
