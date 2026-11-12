'use client';
import { Paperclip, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type DragEvent } from 'react';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import type { AttachmentsState } from '../model/use-attachments';

/** Drag-and-drop + keyboard-operable file input, with a progress bar and a cancel button per upload. */
export const AttachmentPicker = ({ state, label }: { state: AttachmentsState; label: string }) => {
  const t = useTranslations('attach');
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    state.add([...e.dataTransfer.files]);
  };
  return (
    <div className="grid gap-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-testid="dropzone"
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-md border border-dashed border-input p-3 text-sm',
          over && 'border-primary bg-accent',
        )}
      >
        <input
          id={inputId}
          ref={input}
          type="file"
          multiple
          className="sr-only"
          aria-label={label}
          onChange={(e) => {
            state.add([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
          <Paperclip aria-hidden="true" />
          {t('add')}
        </Button>
        <span className="text-muted-foreground">{t('drop')}</span>
      </div>
      {state.notice ? (
        <p role="alert" className="text-sm text-destructive">
          {t(state.notice.key, { n: state.notice.n ?? 0 })}
        </p>
      ) : null}
      {state.items.length > 0 ? (
        <ul className="grid gap-2" aria-label={label}>
          {state.items.map((i) => (
            <li
              key={i.key}
              className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate" title={i.name}>
                {i.name}
              </span>
              {i.status === 'uploading' ? (
                <>
                  <progress
                    className="h-2 w-28"
                    value={Math.round(i.progress * 100)}
                    max={100}
                    aria-label={t('uploading', { percent: Math.round(i.progress * 100) })}
                  />
                  <span aria-hidden="true" className="w-10 text-right tabular-nums">
                    {Math.round(i.progress * 100)}%
                  </span>
                </>
              ) : null}
              {i.status === 'error' ? (
                <span role="alert" className="text-destructive">
                  {t(i.errorKey ?? 'failed', { name: i.name })}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => state.remove(i.key)}
                aria-label={i.status === 'uploading' ? t('cancel') : t('remove', { name: i.name })}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
