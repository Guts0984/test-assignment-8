import { describe, expect, it, vi } from 'vitest';
import { clearAllDrafts, clearDraft, debounce, loadDraft, saveDraft } from './drafts';

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
};
const text = (raw: unknown) =>
  raw && typeof raw === 'object' && typeof (raw as { body?: unknown }).body === 'string'
    ? (raw as { body: string })
    : null;

describe('drafts (acceptance #15: a half-written reply survives a reload)', () => {
  it('round-trips a draft', () => {
    const s = memory();
    expect(saveDraft('ticket:1', { body: 'half a sentence' }, s)).toBe(true);
    expect(loadDraft('ticket:1', text, s)).toEqual({ body: 'half a sentence' });
  });
  it('drafts of different tickets / accounts never mix', () => {
    const s = memory();
    saveDraft('ticket:1', { body: 'one' }, s);
    saveDraft('ticket:2', { body: 'two' }, s);
    expect(loadDraft('ticket:1', text, s)?.body).toBe('one');
    expect(loadDraft('ticket:2', text, s)?.body).toBe('two');
    expect(loadDraft('ticket:3', text, s)).toBeNull();
  });
  it.each([
    ['not json', '{oops'],
    ['wrong shape', JSON.stringify({ x: 1 })],
    ['a number', '42'],
    ['null', 'null'],
    ['an array', '[]'],
  ])('a corrupt stored value (%s) behaves like "no draft"', (_n, raw) => {
    const s = memory();
    s.setItem('helpdesk:draft:k', raw);
    expect(loadDraft('k', text, s)).toBeNull();
  });
  it('storage that throws (quota, blocked) never breaks the form', () => {
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadDraft('k', text, bad)).toBeNull();
    expect(saveDraft('k', { body: 'x' }, bad)).toBe(false);
    expect(() => clearDraft('k', bad)).not.toThrow();
    expect(saveDraft('k', { body: 'x' }, null)).toBe(false);
    expect(loadDraft('k', text, null)).toBeNull();
  });
  it('clearDraft removes it; clearAllDrafts removes ours only (sign-out on a shared computer)', () => {
    const s = memory();
    saveDraft('a', { body: '1' }, s);
    saveDraft('b', { body: '2' }, s);
    s.setItem('unrelated', 'keep me');
    clearDraft('a', s);
    expect(loadDraft('a', text, s)).toBeNull();
    clearAllDrafts(s);
    expect(loadDraft('b', text, s)).toBeNull();
    expect(s.getItem('unrelated')).toBe('keep me');
  });
  it('debounce saves once after typing stops; flush() saves immediately (before navigating away)', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const d = debounce(save, 500);
    d('a');
    d('ab');
    d('abc');
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc');
    d('later');
    d.flush();
    expect(save).toHaveBeenLastCalledWith('later');
    d('cancelled');
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
