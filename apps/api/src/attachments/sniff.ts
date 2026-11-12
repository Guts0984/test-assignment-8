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

const u32 = (b: Uint8Array, o: number): number =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const le32 = (b: Uint8Array, o: number): number =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array, from: number, to: number): number => {
  let c = 0xffffffff;
  for (let i = from; i < to; i += 1) c = (CRC_TABLE[(c ^ (b[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const tag = (b: Uint8Array, o: number, s: string): boolean => startsWith(b, ascii(s), o);

/** PNG: signature, then well-formed chunks (length + CRC), IHDR first, IEND LAST and nothing after it. */
const validPng = (b: Uint8Array): boolean => {
  let o = 8;
  let first = true;
  while (o + 12 <= b.length) {
    const len = u32(b, o);
    const end = o + 12 + len;
    if (end > b.length) return false;
    if (u32(b, end - 4) !== crc32(b, o + 4, o + 8 + len)) return false;
    if (first) {
      if (!tag(b, o + 4, 'IHDR') || len !== 13) return false;
      first = false;
    }
    if (tag(b, o + 4, 'IEND')) return len === 0 && end === b.length;
    o = end;
  }
  return false;
};

/** JPEG: walks the marker segments up to the scan data; ends with EOI (trailing zero padding tolerated). */
const validJpeg = (b: Uint8Array): boolean => {
  let end = b.length;
  while (end > 2 && b[end - 1] === 0) end -= 1;
  if (b[end - 2] !== 0xff || b[end - 1] !== 0xd9) return false;
  let o = 2;
  while (o + 2 <= end) {
    if (b[o] !== 0xff) return false;
    const marker = b[o + 1] ?? 0;
    if (marker === 0xd9) return o + 2 === end;
    if (marker === 0xda) return true; // start of scan: entropy-coded data follows (checked by the EOI above)
    if (marker === 0xff) {
      o += 1;
      continue;
    }
    if (o + 4 > end) return false;
    const len = ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0);
    if (len < 2 || o + 2 + len > end) return false;
    o += 2 + len;
  }
  return false;
};

/** GIF: header + logical screen descriptor, and the 0x3B trailer as the very last byte. */
const validGif = (b: Uint8Array): boolean => b.length >= 14 && b[b.length - 1] === 0x3b;

/** WebP: RIFF length matches the file, first chunk is a real WebP chunk that fits. */
const validWebp = (b: Uint8Array): boolean => {
  if (b.length < 20 || le32(b, 4) + 8 !== b.length) return false;
  const known = ['VP8 ', 'VP8L', 'VP8X'].some((t) => tag(b, 12, t));
  return known && 20 + le32(b, 16) <= b.length;
};

const OBJ_AT = /^\s*\d+\s+\d+\s+obj\b/;
/** Active content or embedded payloads: a PDF carrying any of these is refused (plain keywords; compressed object streams are not inspected). */
const PDF_ACTIVE =
  /\/(EmbeddedFile|EmbeddedFiles|Launch|JavaScript|JS|RichMedia|SubmitForm|ImportData|GoToE|GoToR)\b/;

/**
 * PDF, parsed instead of pattern-matched: version header; `startxref` pointing at a real cross-reference section; every
 * classic xref entry pointing at an `N G obj`; a trailer naming /Root; no embedded files / launch / script actions.
 * (A binary payload inside a valid stream cannot be told from data, which is why PDFs are served only as attachments
 * under a sandboxing CSP and are never rendered by the app.)
 */
const validPdf = (b: Uint8Array): boolean => {
  const text = new TextDecoder('latin1').decode(b);
  if (!/^%PDF-[12]\.\d[\r\n]/.test(text.slice(0, 12))) return false;
  const tailStart = Math.max(0, text.length - 1024);
  const tail = text.slice(tailStart);
  const m = /startxref\s+(\d{1,12})\s+%%EOF\s*$/.exec(tail);
  if (!m) return false;
  const xrefAt = Number(m[1]);
  if (!Number.isSafeInteger(xrefAt) || xrefAt <= 0 || xrefAt >= b.length) return false;
  if (PDF_ACTIVE.test(text)) return false;

  const atXref = text.slice(xrefAt, xrefAt + 64);
  if (/^\s*xref\b/.test(atXref)) {
    // classic table: "start count" then 20-byte entries "oooooooooo ggggg n|f"
    const re = /\s*(\d+)\s+(\d+)[ \t]*\r?\n/y;
    let pos = text.indexOf('xref', xrefAt) + 4;
    let seen = 0;
    for (;;) {
      re.lastIndex = pos;
      const sub = re.exec(text);
      if (!sub) break;
      const count = Number(sub[2]);
      pos = re.lastIndex;
      if (count > 100_000 || seen + count > 100_000) return false;
      for (let i = 0; i < count; i += 1) {
        const e = /^(\d{10}) (\d{5}) ([nf])\s{1,2}/.exec(text.slice(pos, pos + 22));
        if (!e) return false;
        if (e[3] === 'n') {
          const off = Number(e[1]);
          if (off >= b.length || !OBJ_AT.test(text.slice(off, off + 40))) return false;
        }
        pos += e[0].length;
        seen += 1;
      }
    }
    const trailer = text.indexOf('trailer', pos);
    return trailer >= 0 && /\/Root\s+\d+\s+\d+\s+R/.test(text.slice(trailer, trailer + 2048));
  }
  // cross-reference STREAM (PDF 1.5+): it is an indirect object that declares /Type /XRef and names /Root
  return (
    OBJ_AT.test(atXref) &&
    /\/Type\s*\/XRef/.test(text.slice(xrefAt, xrefAt + 512)) &&
    /\/Root\s+\d+\s+\d+\s+R/.test(text.slice(xrefAt, xrefAt + 1024))
  );
};

/**
 * Decides the file type from its CONTENT, never from the name or the client's Content-Type. The signature alone is
 * not enough (a PNG header glued to executable bytes must not pass): each format is checked structurally.
 * Anything not on the allow-list — executables, archives, HTML, SVG, scripts — returns null.
 */
export const sniffMime = (b: Uint8Array): AllowedMime | null => {
  if (b.length === 0) return null;
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return validPng(b) ? 'image/png' : null;
  if (startsWith(b, [0xff, 0xd8, 0xff])) return validJpeg(b) ? 'image/jpeg' : null;
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')))
    return validGif(b) ? 'image/gif' : null;
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8))
    return validWebp(b) ? 'image/webp' : null;
  if (startsWith(b, ascii('%PDF-'))) return validPdf(b) ? 'application/pdf' : null;
  return isPlainText(b) ? 'text/plain' : null;
};

/** File extensions that agree with each detected type. */
export const EXTENSIONS: Record<AllowedMime, readonly string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg', 'jfif'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'log', 'md', 'csv', 'tsv', 'json', 'yml', 'yaml', 'ini'],
};

/**
 * The stored display name must agree with the content: `evil.exe` holding a PNG, or `run.bat` / `a.html` holding text,
 * is refused (null). A name without an extension gets the canonical one.
 */
export const nameForMime = (name: string, mime: AllowedMime): string | null => {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === '') return `${name.replace(/\.+$/, '')}.${EXTENSIONS[mime][0]}`;
  return EXTENSIONS[mime].includes(ext) ? name : null;
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
