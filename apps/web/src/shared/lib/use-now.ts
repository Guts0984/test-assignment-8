'use client';
import { useSyncExternalStore } from 'react';

/** ONE shared timer for every countdown on screen (not a timer per row). */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 5_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

/** Current time, refreshed every few seconds. During SSR / hydration it is a fixed value (no mismatch). */
export const useNow = (): number =>
  useSyncExternalStore(
    subscribe,
    () => now,
    () => 0,
  );
