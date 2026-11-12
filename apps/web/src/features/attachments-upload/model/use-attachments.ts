'use client';
import { useCallback, useReducer, useRef, useState } from 'react';
import { isApiError } from '@/shared/api/errors';
import { api } from '@/shared/api/client';
import { uploadFile } from '@/shared/api/upload';
import {
  attachmentsReducer,
  isUploading,
  planFiles,
  readyIds,
  type AttachmentItem,
} from './attachments';

/** Uploads start as soon as files are chosen/dropped; each has progress and can be cancelled. */
export const useAttachments = () => {
  const [items, dispatch] = useReducer(attachmentsReducer, [] as readonly AttachmentItem[]);
  const [notice, setNotice] = useState<{ key: 'tooMany' | 'rejectedSize'; n?: number } | null>(
    null,
  );
  const handles = useRef(new Map<string, { cancel: () => void }>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const add = useCallback((files: readonly File[]) => {
    const plan = planFiles(itemsRef.current, files);
    const first = plan.rejected[0];
    setNotice(
      first
        ? first.reason === 'tooMany'
          ? { key: 'tooMany', n: 5 }
          : { key: 'rejectedSize' }
        : null,
    );
    for (const index of plan.accept) {
      const file = files[index];
      if (!file) continue;
      const key = crypto.randomUUID();
      dispatch({
        type: 'add',
        item: { key, name: file.name, size: file.size, status: 'uploading', progress: 0 },
      });
      const h = uploadFile(file, {
        baseUrl: api.baseUrl,
        onProgress: (progress) => dispatch({ type: 'progress', key, progress }),
      });
      handles.current.set(key, h);
      h.promise.then(
        (attachment) => {
          handles.current.delete(key);
          dispatch({ type: 'done', key, attachment });
        },
        (err: unknown) => {
          handles.current.delete(key);
          if (err instanceof Error && err.name === 'AbortError') return; // cancelled: the item is already gone
          dispatch({
            type: 'error',
            key,
            errorKey:
              isApiError(err) && err.info.status === 415
                ? 'rejectedType'
                : isApiError(err) && err.info.status === 413
                  ? 'rejectedSize'
                  : 'failed',
          });
        },
      );
    }
  }, []);

  const remove = useCallback((key: string) => {
    handles.current.get(key)?.cancel(); // an upload in flight is aborted, not left running
    handles.current.delete(key);
    dispatch({ type: 'remove', key });
  }, []);

  const clear = useCallback(() => {
    for (const h of handles.current.values()) h.cancel();
    handles.current.clear();
    dispatch({ type: 'clear' });
    setNotice(null);
  }, []);

  return { items, add, remove, clear, ids: readyIds(items), uploading: isUploading(items), notice };
};
export type AttachmentsState = ReturnType<typeof useAttachments>;
