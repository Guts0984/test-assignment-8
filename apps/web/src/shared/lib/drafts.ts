/**
 * Drafts survive a reload because they live in localStorage. Every access is guarded: storage can be missing
 * (private mode), full, or hold garbage from an older version — none of that may ever break the form.
 */
const PREFIX = 'helpdesk:draft:';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): Store | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // access itself can throw (blocked cookies)
  }
};

export const loadDraft = <T>(
  key: string,
  validate: (raw: unknown) => T | null,
  store: Store | null = defaultStore(),
): T | null => {
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + key);
    return raw === null ? null : validate(JSON.parse(raw));
  } catch {
    return null; // corrupt JSON or a storage error: behave as "no draft"
  }
};

export const saveDraft = (
  key: string,
  value: unknown,
  store: Store | null = defaultStore(),
): boolean => {
  if (!store) return false;
  try {
    store.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota exceeded
  }
};

export const clearDraft = (key: string, store: Store | null = defaultStore()): void => {
  try {
    store?.removeItem(PREFIX + key);
  } catch {
    /* nothing to do */
  }
};

/** Clears drafts of other accounts when someone signs out on a shared computer. */
export const clearAllDrafts = (
  store:
    | (Store & { length?: number; key?: (i: number) => string | null })
    | null = defaultStore() as never,
): void => {
  try {
    const s = store as (Store & { length: number; key: (i: number) => string | null }) | null;
    if (!s) return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    /* ignore */
  }
};

/** Trailing-edge debounce for saving while typing. */
export const debounce = <A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): ((...a: A) => void) & { flush: () => void; cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: A | undefined;
  const run = () => {
    timer = undefined;
    if (last) fn(...last);
    last = undefined;
  };
  const d = ((...a: A) => {
    last = a;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as ((...a: A) => void) & { flush: () => void; cancel: () => void };
  d.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  d.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    last = undefined;
  };
  return d;
};
