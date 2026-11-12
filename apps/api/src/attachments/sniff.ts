import type { ALLOWED_ATTACHMENT_MIME } from '@helpdesk/shared';

export type AllowedMime = (typeof ALLOWED_ATTACHMENT_MIME)[number];

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  sig.every((v, i) => b[offset + i] === v);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Allowed text: valid UTF-8, no NUL, no control characters other than tab / newline / carriage return / form feed. */
const isPlainText = (b: Uint8Array): boolean => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    // eslint-disable-next-line no-control-regex -- this IS the control-character check
    return !/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text);
  } catch {
    return false;
  }
};

/**
 * Decides the file type from its CONTENT (magic bytes), never from the name or the client's Content-Type.
 * Anything not on the allow-list — executables, archives, HTML, SVG, scripts — returns null.
 */
export const sniffMime = (b: Uint8Array): AllowedMime | null => {
  if (b.length === 0) return null;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(b, ascii('%PDF-'))) return 'application/pdf';
  return isPlainText(b) ? 'text/plain' : null;
};

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const BIDI_AND_CONTROL = /[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * A safe display name: no directories (either slash style), no control or bidi-override characters
 * (which can disguise "evil.exe" as "evilexe.png"), no leading dots, bounded length.
 */
export const sanitizeFilename = (raw: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let name = base
    .normalize('NFC')
    .replace(BIDI_AND_CONTROL, '')
    .replace(/^[.\s]+/, '')
    .trim();
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name.length > 0 ? name : 'file';
};

/** RFC 6266 / 5987 Content-Disposition value with an ASCII fallback. */
export const contentDisposition = (type: 'inline' | 'attachment', filename: string): string => {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
};
