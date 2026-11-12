import { z } from 'zod';

/** JSON Schema of a shared Zod schema, for `@ApiBody({ schema })` — Swagger can never drift from validation. */
export const jsonSchemaOf = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
