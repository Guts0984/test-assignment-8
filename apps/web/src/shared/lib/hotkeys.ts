/** Should a key press be treated as a shortcut? Not while the user is typing, and not with Ctrl/Cmd/Alt held. */
export const shouldHandleHotkey = (
  e: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target' | 'isComposing' | 'defaultPrevented'
  >,
): boolean => {
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return true;
  const tag = el.tagName;
  // text-like fields must receive the keys; a checkbox/radio input is not for typing (a clicked row checkbox keeps focus)
  const inputType = tag === 'INPUT' ? (el as HTMLInputElement).type : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return false;
  if (tag === 'INPUT' && inputType !== 'checkbox' && inputType !== 'radio') return false;
  // Enter on a focused button/link must activate THAT control, not our "open ticket" shortcut
  if (
    e.key === 'Enter' &&
    (tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button')
  )
    return false;
  return true;
};

/** Index after a j/k move, clamped to the list (-1 = nothing selected yet). */
export const moveSelection = (current: number, delta: 1 | -1, length: number): number => {
  if (length === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
};
