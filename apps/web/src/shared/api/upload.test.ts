import { describe, expect, it } from 'vitest';
import { uploadFile } from './upload';

type FakeXhr = ReturnType<typeof fakeXhr>;
const fakeXhr = () => {
  const x = {
    status: 0,
    responseText: '',
    method: '',
    url: '',
    withCredentials: false,
    responseType: '',
    sent: null as unknown,
    aborted: false,
    upload: { onprogress: null as ((e: ProgressEvent) => void) | null },
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    ontimeout: null as (() => void) | null,
    onabort: null as (() => void) | null,
    open(m: string, u: string) {
      x.method = m;
      x.url = u;
    },
    send(body: unknown) {
      x.sent = body;
    },
    abort() {
      x.aborted = true;
      x.onabort?.();
    },
    getResponseHeader: (_: string) => null as string | null,
  };
  return x;
};
const run = (file = new File(['hello'], 'a.txt', { type: 'text/plain' })) => {
  const xhr: FakeXhr = fakeXhr();
  const progress: number[] = [];
  const h = uploadFile(file, {
    baseUrl: '/api',
    onProgress: (f) => progress.push(f),
    xhrFactory: () => xhr as unknown as XMLHttpRequest,
  });
  return { xhr, progress, ...h };
};
const finish = (xhr: FakeXhr, status: number, body: unknown) => {
  xhr.status = status;
  xhr.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  xhr.onload?.();
};

describe('uploadFile (progress and cancel)', () => {
  it('POSTs multipart to /attachments with credentials and the file under the "file" field', () => {
    const { xhr } = run();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/attachments');
    expect(xhr.withCredentials).toBe(true);
    expect((xhr.sent as FormData).get('file')).toBeInstanceOf(File);
  });
  it('reports progress as a fraction, clamped to 0..1, ignoring indeterminate events', async () => {
    const { xhr, progress, promise } = run();
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 } as ProgressEvent);
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 } as ProgressEvent);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 150, total: 100 } as ProgressEvent);
    finish(xhr, 201, { id: 'i', name: 'a.txt', mime: 'text/plain', sizeBytes: 5 });
    await promise;
    expect(progress).toEqual([0.25, 1, 1]);
  });
  it('resolves with the attachment on 201', async () => {
    const { xhr, promise } = run();
    finish(xhr, 201, { id: 'abc', name: 'a.txt', mime: 'text/plain', sizeBytes: 5 });
    await expect(promise).resolves.toMatchObject({ id: 'abc' });
  });
  it.each([
    [
      415,
      { error: { code: 'unsupported_media_type', message: 'x', status: 415 } },
      'unsupported_media_type',
    ],
    [413, { error: { code: 'payload_too_large', message: 'x', status: 413 } }, 'payload_too_large'],
    [
      429,
      { error: { code: 'rate_limited', message: 'x', status: 429, retryAfterSeconds: 3 } },
      'rate_limited',
    ],
    [502, '<html>bad gateway</html>', 'internal_error'],
  ])('HTTP %i → an ApiError the UI can translate', async (status, body, code) => {
    const { xhr, promise } = run();
    finish(xhr, status, body);
    await expect(promise).rejects.toMatchObject({ name: 'ApiError', info: { status, code } });
  });
  it('a 2xx with an unusable body is an error, not a fake success', async () => {
    const { xhr, promise } = run();
    finish(xhr, 200, 'not json');
    await expect(promise).rejects.toMatchObject({ name: 'ApiError' });
  });
  it('a network failure is a network_error', async () => {
    const { xhr, promise } = run();
    xhr.onerror?.();
    await expect(promise).rejects.toMatchObject({ info: { code: 'network_error' } });
  });
  it('cancel() aborts the request and rejects with AbortError (not an ApiError)', async () => {
    const { xhr, promise, cancel } = run();
    cancel();
    expect(xhr.aborted).toBe(true);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
