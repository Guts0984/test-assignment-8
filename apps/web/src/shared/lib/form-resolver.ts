import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

/**
 * A localisable validation message: `key` is looked up under `validation.*`, `n` fills the ICU placeholder.
 * Encoded as `key` or `key:n` so it can travel in RHF's `message` string.
 */
export const encodeIssue = (issue: z.core.$ZodIssue): string => {
  switch (issue.code) {
    case 'too_small':
      return issue.origin === 'string' && Number(issue.minimum) <= 1
        ? 'required'
        : `tooSmall:${String(issue.minimum)}`;
    case 'too_big':
      return `tooBig:${String(issue.maximum)}`;
    case 'invalid_format':
      return issue.format === 'email' ? 'email' : 'invalid';
    case 'invalid_type':
      return issue.input === undefined || issue.input === null || issue.input === ''
        ? 'required'
        : 'invalid';
    default:
      return 'invalid';
  }
};

export const decodeIssue = (message: string | undefined): { key: string; n?: number } => {
  const [key = 'invalid', n] = (message ?? 'invalid').split(':');
  return n !== undefined && Number.isFinite(Number(n)) ? { key, n: Number(n) } : { key };
};

/**
 * React Hook Form resolver for a shared Zod schema that yields translatable messages (the shared schemas
 * carry English text meant for the API; the UI must speak the user's language) and keeps the schema's
 * transforms (trim, lowercase) in the submitted values.
 */
export const zodFormResolver =
  <S extends z.ZodType<FieldValues>>(schema: S): Resolver<z.input<S> & FieldValues> =>
  async (values) => {
    const parsed = schema.safeParse(values);
    if (parsed.success) return { values: parsed.data as z.input<S> & FieldValues, errors: {} }; // transformed values (trimmed, lower-cased)
    const errors: Record<string, { type: string; message: string }> = {};
    for (const issue of parsed.error.issues) {
      const name = issue.path.join('.');
      if (!name || errors[name]) continue;
      // an empty / whitespace-only text field is "required", whatever format rule it also breaks
      const raw = issue.path.reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<PropertyKey, unknown>)[k] : undefined),
        values,
      );
      const blank = typeof raw === 'string' && raw.trim() === '';
      errors[name] = { type: issue.code, message: blank ? 'required' : encodeIssue(issue) };
    }
    return { values: {}, errors: errors as FieldErrors<z.input<S> & FieldValues> };
  };
