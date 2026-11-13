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
  | { type: 'restore'; attachments: readonly AttachmentDto[] }
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
    case 'restore': {
      // files uploaded in an earlier visit and still waiting on the server: shown as finished uploads
      const have = new Set(items.flatMap((i) => (i.attachment ? [i.attachment.id] : [])));
      const added: AttachmentItem[] = a.attachments
        .filter((x) => !have.has(x.id))
        .map((x) => ({
          key: x.id,
          name: x.name,
          size: x.sizeBytes,
          status: 'done' as const,
          progress: 1,
          attachment: x,
        }));
      return [...items, ...added].slice(0, LIMITS.attachmentsPerMessage);
    }
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

/** The finished uploads, as they are stored in a draft. */
export const doneAttachments = (items: readonly AttachmentItem[]): AttachmentDto[] =>
  items.flatMap((i) => (i.status === 'done' && i.attachment ? [i.attachment] : []));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Whatever an old or corrupt draft holds → a safe list of attachment references (at most 5). */
export const parseAttachmentRefs = (raw: unknown): AttachmentDto[] =>
  Array.isArray(raw)
    ? raw
        .flatMap((x): AttachmentDto[] => {
          if (!x || typeof x !== 'object') return [];
          const r = x as Record<string, unknown>;
          return typeof r.id === 'string' &&
            UUID.test(r.id) &&
            typeof r.name === 'string' &&
            typeof r.mime === 'string' &&
            typeof r.sizeBytes === 'number'
            ? [
                {
                  id: r.id,
                  name: r.name.slice(0, 200),
                  mime: r.mime.slice(0, 100),
                  sizeBytes: r.sizeBytes,
                },
              ]
            : [];
        })
        .slice(0, LIMITS.attachmentsPerMessage)
    : [];
