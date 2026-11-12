'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { Button } from '@/shared/ui/button';

/** Modal cheat-sheet opened with "?". Esc closes; focus moves in and returns to where it was. */
export const HotkeyHelp = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const t = useTranslations('queue.hotkeys');
  const tc = useTranslations('common'); // hooks first: nothing may be called after the early return below
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        e.preventDefault(); // one focusable control: keep focus inside the dialog
        close.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const rows: Array<[string, string]> = [
    ['j', t('next')],
    ['k', t('prev')],
    ['Enter', t('open')],
    ['/', t('search')],
    ['?', t('help')],
    ['Ctrl/⌘ + Enter', t('send')],
  ];
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hotkeys-title"
        className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl"
      >
        <h2 id="hotkeys-title" className="mb-3 text-lg font-semibold">
          {t('title')}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([k, label]) => (
            <div key={k} className="contents">
              <dt>
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">
                  {k}
                </kbd>
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 text-right">
          <Button ref={close} onClick={onClose}>
            {tc('close')}
          </Button>
        </div>
      </div>
    </div>
  );
};
