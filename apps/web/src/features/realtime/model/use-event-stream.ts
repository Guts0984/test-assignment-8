'use client';
import { useEffect, useRef, useState } from 'react';
import type { SseEvent } from '@helpdesk/shared';
import { connectEventStream, type StreamStatus } from './event-stream';

/** Subscribes to the live event stream while the component is mounted (one connection per call site). */
export const useEventStream = (onEvent: (e: SseEvent) => void, enabled = true): StreamStatus => {
  const [status, setStatus] = useState<StreamStatus>('closed');
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!enabled) return undefined;
    return connectEventStream(`${process.env.NEXT_PUBLIC_API_BASE ?? '/api'}/events`, {
      onEvent: (e) => handler.current(e),
      onStatus: setStatus,
    });
  }, [enabled]);
  return status;
};
