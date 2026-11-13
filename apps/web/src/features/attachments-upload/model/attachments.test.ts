import { describe, expect, it } from 'vitest';
import {
  attachmentsReducer,
  isUploading,
  planFiles,
  readyIds,
  parseAttachmentRefs,
  doneAttachments,
  type AttachmentItem,
} from './attachments';

const item = (key: string, over: Partial<AttachmentItem> = {}): AttachmentItem => ({
  key,
  name: `${key}.png`,
  size: 10,
  status: 'uploading',
  progress: 0,
  ...over,
});
const att = (id: string) => ({ id, name: 'a', mime: 'image/png', sizeBytes: 10 });

describe('attachments reducer', () => {
  it('walks an upload through progress → done; only finished ones give ids', () => {
    let s: readonly AttachmentItem[] = [];
    s = attachmentsReducer(s, { type: 'add', item: item('a') });
    s = attachmentsReducer(s, { type: 'add', item: item('b') });
    expect(isUploading(s)).toBe(true);
    s = attachmentsReducer(s, { type: 'progress', key: 'a', progress: 0.5 });
    s = attachmentsReducer(s, { type: 'done', key: 'a', attachment: att('id-a') });
    expect(readyIds(s)).toEqual(['id-a']);
    expect(isUploading(s)).toBe(true);
    s = attachmentsReducer(s, { type: 'error', key: 'b', errorKey: 'rejectedType' });
    expect(isUploading(s)).toBe(false);
    expect(readyIds(s)).toEqual(['id-a']);
    expect(s[1]).toMatchObject({ status: 'error', errorKey: 'rejectedType' });
  });
  it('late progress for a finished or removed upload is ignored', () => {
    let s: readonly AttachmentItem[] = [item('a')];
    s = attachmentsReducer(s, { type: 'done', key: 'a', attachment: att('x') });
    expect(attachmentsReducer(s, { type: 'progress', key: 'a', progress: 0.1 })[0]?.progress).toBe(
      1,
    );
    s = attachmentsReducer(s, { type: 'remove', key: 'a' });
    expect(attachmentsReducer(s, { type: 'progress', key: 'a', progress: 0.5 })).toEqual([]);
  });
  it('remove and clear', () => {
    expect(
      attachmentsReducer([item('a'), item('b')], { type: 'remove', key: 'a' }).map((i) => i.key),
    ).toEqual(['b']);
    expect(attachmentsReducer([item('a')], { type: 'clear' })).toEqual([]);
  });
});

describe('planFiles (client-side pre-checks)', () => {
  const f = (size: number) => ({ name: 'x', size });
  it('accepts up to 5 files in total; failed uploads do not count against the limit', () => {
    const existing = [
      item('1', { status: 'done' }),
      item('2', { status: 'done' }),
      item('3', { status: 'error' }),
    ];
    const plan = planFiles(existing, [f(1), f(1), f(1), f(1)]);
    expect(plan.accept).toEqual([0, 1, 2]);
    expect(plan.rejected).toEqual([{ index: 3, reason: 'tooMany' }]);
  });
  it('refuses files over 10 MB exactly at the boundary', () => {
    const plan = planFiles([], [f(10 * 1024 * 1024), f(10 * 1024 * 1024 + 1)]);
    expect(plan.accept).toEqual([0]);
    expect(plan.rejected).toEqual([{ index: 1, reason: 'rejectedSize' }]);
  });
  it('an oversized file does not eat a slot', () => {
    const plan = planFiles([], [f(99_999_999), f(1), f(1), f(1), f(1), f(1)]);
    expect(plan.accept).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('draft attachments', () => {
  const a = (n: number) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name: `f${n}.png`,
    mime: 'image/png',
    sizeBytes: n,
  });
  it('restore adds finished uploads, never twice, never beyond the per-message limit', () => {
    let s: readonly AttachmentItem[] = [];
    s = attachmentsReducer(s, { type: 'restore', attachments: [a(1), a(2)] });
    expect(s.map((i) => i.status)).toEqual(['done', 'done']);
    expect(readyIds(s)).toEqual([a(1).id, a(2).id]);
    s = attachmentsReducer(s, { type: 'restore', attachments: [a(2), a(3)] });
    expect(readyIds(s)).toEqual([a(1).id, a(2).id, a(3).id]);
    s = attachmentsReducer(s, { type: 'restore', attachments: [a(4), a(5), a(6), a(7)] });
    expect(s).toHaveLength(5);
  });
  it('only finished uploads go into a draft', () => {
    const s = [
      item('a', { status: 'done', attachment: a(1) }),
      item('b'),
      item('c', { status: 'error' }),
    ];
    expect(doneAttachments(s)).toEqual([a(1)]);
  });
  it('a corrupt or hand-edited draft yields only well-formed references', () => {
    expect(parseAttachmentRefs(undefined)).toEqual([]);
    expect(parseAttachmentRefs('x')).toEqual([]);
    expect(
      parseAttachmentRefs([a(1), { id: 'nope', name: 'x', mime: 'm', sizeBytes: 1 }, null, 7]),
    ).toEqual([a(1)]);
    expect(parseAttachmentRefs(Array.from({ length: 9 }, (_, i) => a(i + 1)))).toHaveLength(5);
  });
});
