import { LIMITS, type AttachmentDto } from '@helpdesk/shared';

export type AttachmentItem = {
  key: string;
  name: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  attachment?: AttachmentDto;
  /** i18n key under `attach.*` */
  errorKey?: 'failed' | 'rejectedType' | 'rejectedSize';
};

export type AttachmentAction =
  | { type: 'add'; item: AttachmentItem }
  | { type: 'progress'; key: string; progress: number }
  | { type: 'done'; key: string; attachment: AttachmentDto }
  | { type: 'error'; key: string; errorKey: NonNullable<AttachmentItem['errorKey']> }
  | { type: 'remove'; key: string }
  | { type: 'clear' };

export const attachmentsReducer = (
  items: readonly AttachmentItem[],
  a: AttachmentAction,
): readonly AttachmentItem[] => {
  switch (a.type) {
    case 'add':
      return [...items, a.item];
    case 'progress':
      return items.map((i) =>
        i.key === a.key && i.status === 'uploading' ? { ...i, progress: a.progress } : i,
      );
    case 'done':
      return items.map((i) =>
        i.key === a.key ? { ...i, status: 'done', progress: 1, attachment: a.attachment } : i,
      );
    case 'error':
      return items.map((i) =>
        i.key === a.key ? { ...i, status: 'error', errorKey: a.errorKey } : i,
      );
    case 'remove':
      return items.filter((i) => i.key !== a.key);
    case 'clear':
      return [];
  }
};

/** Client-side pre-checks (the server re-checks everything, by content). Returns which files may start uploading. */
export const planFiles = (
  existing: readonly AttachmentItem[],
  files: readonly { name: string; size: number }[],
): { accept: number[]; rejected: Array<{ index: number; reason: 'rejectedSize' | 'tooMany' }> } => {
  const accept: number[] = [];
  const rejected: Array<{ index: number; reason: 'rejectedSize' | 'tooMany' }> = [];
  let count = existing.filter((i) => i.status !== 'error').length;
  files.forEach((f, index) => {
    if (f.size > LIMITS.attachmentMaxBytes) rejected.push({ index, reason: 'rejectedSize' });
    else if (count >= LIMITS.attachmentsPerMessage) rejected.push({ index, reason: 'tooMany' });
    else {
      accept.push(index);
      count += 1;
    }
  });
  return { accept, rejected };
};

export const readyIds = (items: readonly AttachmentItem[]): string[] =>
  items.flatMap((i) => (i.status === 'done' && i.attachment ? [i.attachment.id] : []));
export const isUploading = (items: readonly AttachmentItem[]): boolean =>
  items.some((i) => i.status === 'uploading');
