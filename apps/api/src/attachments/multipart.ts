import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { appError } from '../lib/errors';

/** Multipart framing (boundaries, headers) on top of the file bytes. */
const FRAMING_ALLOWANCE = 64 * 1024;

export type ParsedUpload = { filename: string; bytes: Buffer };

/**
 * Reads ONE file field named `file` from a multipart/form-data request.
 * The byte limit is enforced while streaming (a 5 GB body is cut off after `maxBytes`, never buffered),
 * any other field or file is rejected, and malformed multipart is a 400 — never a 500.
 */
export const readSingleFile = async (
  req: IncomingMessage,
  maxBytes: number,
): Promise<ParsedUpload> => {
  const contentType = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
    throw appError(
      415,
      'unsupported_media_type',
      'Send the file as multipart/form-data with a "file" field',
    );
  }
  const limit = maxBytes + FRAMING_ALLOWANCE;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit)
    throw appError(413, 'payload_too_large', 'File is too large');

  let received = 0;
  let tooLarge = false;
  const counted = Readable.toWeb(req).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > limit) {
          tooLarge = true;
          controller.error(new Error('body too large'));
        } else controller.enqueue(chunk);
      },
    }),
  );

  let form: FormData;
  try {
    form = await new Request('http://upload.local/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: counted,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }).formData();
  } catch {
    if (tooLarge) throw appError(413, 'payload_too_large', 'File is too large');
    throw appError(400, 'bad_request', 'Malformed multipart body');
  }

  const entries = [...form.entries()];
  const first = entries[0];
  if (entries.length !== 1 || !first || first[0] !== 'file' || typeof first[1] === 'string') {
    throw appError(400, 'validation_error', 'Exactly one file field named "file" is required');
  }
  const file = first[1];
  if (file.size > maxBytes) throw appError(413, 'payload_too_large', 'File is larger than 10 MB');
  if (file.size === 0) throw appError(400, 'validation_error', 'The file is empty');
  return { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
};
