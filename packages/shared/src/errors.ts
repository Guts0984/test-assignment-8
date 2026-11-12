import { z } from 'zod';

export const ERROR_CODES = [
  'validation_error',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'version_conflict',
  'rate_limited',
  'payload_too_large',
  'unsupported_media_type',
  'bad_request',
  'invalid_transition',
  'service_unavailable',
  'internal_error',
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Single error format used by every API endpoint. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    status: z.number().int(),
    requestId: z.string().optional(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /** Present on 409 version conflicts: the current server state. */
    current: z.unknown().optional(),
    retryAfterSeconds: z.number().int().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
