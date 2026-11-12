import { z } from 'zod';
import { LIMITS } from './enums';

/** Strings must not contain NUL bytes (PostgreSQL rejects them with a 500-class error). */
const noNul = (s: string) => !s.includes('\u0000');

export const uuidSchema = z.uuid();

export const textSchema = (min: number, max: number) =>
  z.string().min(min).max(max).refine(noNul, { message: 'must not contain NUL characters' });

export const subjectSchema = textSchema(1, LIMITS.subjectMax)
  .transform((s) => s.trim())
  .pipe(z.string().min(1, 'subject must not be blank'));

export const tagSchema = textSchema(1, LIMITS.tagMax)
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().min(1));

export const tagsSchema = z
  .array(tagSchema)
  .max(LIMITS.tagsMax)
  .transform((tags) => [...new Set(tags)]);

export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** Query-string helper: accepts `a,b` or repeated `a=1&a=2` and returns string[]. */
export const csvArray = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      (Array.isArray(v) ? v : [v])
        .flatMap((s) => s.split(','))
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(item));
