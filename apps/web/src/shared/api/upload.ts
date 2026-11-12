import { makeApiError, parseErrorBody } from './errors';
import type { AttachmentDto } from '@helpdesk/shared';

export type UploadHandle = { promise: Promise<AttachmentDto>; cancel: () => void };

/**
 * Uploads one file with progress and cancellation (XMLHttpRequest: `fetch` cannot report upload progress).
 * The server decides the type from the content; this only transports the bytes.
 */
export const uploadFile = (
  file: File,
  opts: {
    baseUrl: string;
    onProgress?: (fraction: number) => void;
    xhrFactory?: () => XMLHttpRequest;
  },
): UploadHandle => {
  const xhr = (opts.xhrFactory ?? (() => new XMLHttpRequest()))();
  const promise = new Promise<AttachmentDto>((resolve, reject) => {
    xhr.open('POST', `${opts.baseUrl}/attachments`);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === 'object') {
        opts.onProgress?.(1);
        resolve(body as AttachmentDto);
      } else
        reject(
          makeApiError(parseErrorBody(xhr.status, body, xhr.getResponseHeader('retry-after'))),
        );
    };
    xhr.onerror = () =>
      reject(makeApiError({ status: 0, code: 'network_error', message: 'Network error' }));
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () =>
      reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
  return { promise, cancel: () => xhr.abort() };
};
