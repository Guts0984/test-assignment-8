'use client';
import { useEffect, useRef } from 'react';
import { shouldHandleHotkey } from '@/shared/lib/hotkeys';

/**
 * The shortcut for a key press, by what is printed on the key (`code`) when the layout does not give a Latin letter:
 * on a Ukrainian layout `j` is "о", `k` is "л", `x` is "ч", so `e.key` alone would never match.
 */
const CODE_TO_KEY: Record<string, string> = { KeyJ: 'j', KeyK: 'k', KeyX: 'x' };
export const keyFor = (e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>): string => {
  // a Latin / ASCII key is taken as typed (other Latin layouts keep working); only non-Latin layouts fall back to the physical key
  if (e.key.length === 1 ? e.key.charCodeAt(0) < 128 : true) return e.key;
  if (e.code === 'Slash') return e.shiftKey ? '?' : '/';
  return CODE_TO_KEY[e.code] ?? e.key;
};

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
      const handler = ref.current[keyFor(e)];
      if (!handler || !shouldHandleHotkey(e)) return;
      e.preventDefault();
      handler(e);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
};
