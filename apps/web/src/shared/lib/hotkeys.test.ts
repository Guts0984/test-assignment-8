import { describe, expect, it } from 'vitest';
import { moveSelection, shouldHandleHotkey } from './hotkeys';

const ev = (
  over: Partial<Parameters<typeof shouldHandleHotkey>[0]> & {
    tag?: string;
    editable?: boolean;
    role?: string;
  },
) => {
  const el = Object.assign(
    document.createElement(over.tag ?? 'div'),
    over.editable ? { isContentEditable: true } : {},
  );
  if (over.role) el.setAttribute('role', over.role);
  return {
    key: 'j',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    defaultPrevented: false,
    target: el,
    ...over,
  } as Parameters<typeof shouldHandleHotkey>[0];
};

describe('shouldHandleHotkey', () => {
  it('plain keys on the page are shortcuts', () => {
    expect(shouldHandleHotkey(ev({}))).toBe(true);
    expect(shouldHandleHotkey(ev({ tag: 'tr' }))).toBe(true);
    expect(shouldHandleHotkey(ev({ key: '?' }))).toBe(true);
  });
  it('a focused CHECKBOX does not block shortcuts (clicking a row checkbox keeps focus there)', () => {
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
    expect(
      shouldHandleHotkey({
        key: 'j',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        isComposing: false,
        defaultPrevented: false,
        target: box,
      }),
    ).toBe(true);
    const text = Object.assign(document.createElement('input'), { type: 'text' });
    expect(
      shouldHandleHotkey({
        key: 'j',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        isComposing: false,
        defaultPrevented: false,
        target: text,
      }),
    ).toBe(false);
  });
  it.each(['input', 'textarea', 'select'])(
    'NEVER while typing in a <%s> (the reply box must receive "j" and "/")',
    (tag) => {
      expect(shouldHandleHotkey(ev({ tag }))).toBe(false);
      expect(shouldHandleHotkey(ev({ tag, key: '/' }))).toBe(false);
    },
  );
  it('never inside a contenteditable, during IME composition, or when something already handled the key', () => {
    expect(shouldHandleHotkey(ev({ editable: true }))).toBe(false);
    expect(shouldHandleHotkey(ev({ isComposing: true }))).toBe(false);
    expect(shouldHandleHotkey(ev({ defaultPrevented: true }))).toBe(false);
  });
  it('never with Ctrl / Cmd / Alt (browser and OS shortcuts such as Ctrl+J, Cmd+K)', () => {
    for (const m of ['ctrlKey', 'metaKey', 'altKey'] as const)
      expect(shouldHandleHotkey(ev({ [m]: true }))).toBe(false);
  });
  it('Enter on a focused button / link / role=button activates THAT control, not "open ticket"', () => {
    for (const tag of ['button', 'a'])
      expect(shouldHandleHotkey(ev({ tag, key: 'Enter' }))).toBe(false);
    expect(shouldHandleHotkey(ev({ role: 'button', key: 'Enter' }))).toBe(false);
    expect(shouldHandleHotkey(ev({ tag: 'tr', key: 'Enter' }))).toBe(true);
  });
});

describe('moveSelection', () => {
  it('j from nothing selects the first, k from nothing the last', () => {
    expect(moveSelection(-1, 1, 5)).toBe(0);
    expect(moveSelection(-1, -1, 5)).toBe(4);
  });
  it('clamps at both ends and handles an empty list', () => {
    expect(moveSelection(4, 1, 5)).toBe(4);
    expect(moveSelection(0, -1, 5)).toBe(0);
    expect(moveSelection(2, 1, 5)).toBe(3);
    expect(moveSelection(2, -1, 5)).toBe(1);
    expect(moveSelection(-1, 1, 0)).toBe(-1);
    expect(moveSelection(3, 1, 0)).toBe(-1);
  });
});
