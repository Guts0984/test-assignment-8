import { loginSchema, createTicketSchema } from '@helpdesk/shared';
import { describe, expect, it } from 'vitest';
import { decodeIssue, zodFormResolver } from './form-resolver';

const run = async <T extends Record<string, unknown>>(
  schema: Parameters<typeof zodFormResolver>[0],
  values: T,
) =>
  (
    zodFormResolver(schema) as unknown as (
      v: T,
      c: unknown,
      o: unknown,
    ) => Promise<{
      values: Record<string, unknown>;
      errors: Record<string, { type: string; message: string }>;
    }>
  )(values, undefined, {});

describe('zodFormResolver (translatable validation messages)', () => {
  it('empty required fields → "required" for each, keyed by field', async () => {
    const r = await run(loginSchema, { email: '', password: '' });
    expect(r.errors.email?.message).toBe('required');
    expect(r.errors.password?.message).toBe('required');
    expect(r.values).toEqual({});
  });
  it('bad email → "email"; too long → "tooBig:<max>"; whitespace-only subject → "required"', async () => {
    expect((await run(loginSchema, { email: 'nope', password: 'x' })).errors.email?.message).toBe(
      'email',
    );
    expect(
      (await run(loginSchema, { email: 'a@b.co', password: 'x'.repeat(200) })).errors.password
        ?.message,
    ).toBe('tooBig:128');
    const t = await run(createTicketSchema, {
      subject: '   ',
      category: 'other',
      body: 'b',
      clientMessageId: crypto.randomUUID(),
    });
    expect(t.errors.subject?.message).toBe('required');
    expect(
      (
        await run(createTicketSchema, {
          subject: 'x'.repeat(201),
          category: 'other',
          body: 'b',
          clientMessageId: crypto.randomUUID(),
        })
      ).errors.subject?.message,
    ).toBe('tooBig:200');
  });
  it('on success returns the TRANSFORMED values (email trimmed and lower-cased)', async () => {
    const r = await run(loginSchema, { email: '  Agent@X.TEST ', password: 'pw' });
    expect(r.errors).toEqual({});
    expect(r.values).toEqual({ email: 'agent@x.test', password: 'pw' });
  });
  it('a missing field (undefined) is "required" and unknown values are "invalid"', async () => {
    expect((await run(loginSchema, { password: 'x' })).errors.email?.message).toBe('required');
    expect(
      (
        await run(createTicketSchema, {
          subject: 's',
          category: 'nope',
          body: 'b',
          clientMessageId: crypto.randomUUID(),
        })
      ).errors.category?.message,
    ).toBe('invalid');
  });
  it('decodeIssue splits the key and the number; garbage degrades to "invalid"', () => {
    expect(decodeIssue('tooBig:200')).toEqual({ key: 'tooBig', n: 200 });
    expect(decodeIssue('required')).toEqual({ key: 'required' });
    expect(decodeIssue(undefined)).toEqual({ key: 'invalid' });
    expect(decodeIssue('tooBig:abc')).toEqual({ key: 'tooBig' });
  });
});
