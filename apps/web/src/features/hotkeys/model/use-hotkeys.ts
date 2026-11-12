'use client';
import { useEffect, useRef } from 'react';
import { shouldHandleHotkey } from '@/shared/lib/hotkeys';

/** Global single-key shortcuts that stay out of the way of typing and browser shortcuts. */
export const useHotkeys = (
  map: Readonly<Record<string, (e: KeyboardEvent) => void>>,
  enabled = true,
): void => {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const handler = ref.current[e.key];
      if (!handler || !shouldHandleHotkey(e)) return;
      e.preventDefault();
      handler(e);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
};
