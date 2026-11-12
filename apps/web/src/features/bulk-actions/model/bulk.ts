import type { BulkRequest, BulkResult } from '@helpdesk/shared';

export type BulkReport = { ok: string[]; skipped: Array<{ id: string; reason: string }> };

/** The API takes at most 200 ids per call: split a bigger selection and merge the per-ticket answers (order kept). */
export const chunkIds = (ids: readonly string[], size = 200): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
};

export const summarize = (results: BulkResult['results']): BulkReport => ({
  ok: results.filter((r) => r.ok).map((r) => r.id),
  skipped: results.flatMap((r) => (r.ok ? [] : [{ id: r.id, reason: r.reason }])),
});

export type BulkOperation = BulkRequest['operation'];
