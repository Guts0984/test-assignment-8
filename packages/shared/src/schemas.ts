import { z } from 'zod';
import {
  LIMITS,
  categorySchema,
  customerPrioritySchema,
  localeSchema,
  messageKindSchema,
  prioritySchema,
  roleSchema,
  statusSchema,
  ticketSortSchema,
} from './enums';
import {
  csvArray,
  isoDateTimeSchema,
  subjectSchema,
  tagsSchema,
  textSchema,
  uuidSchema,
} from './primitives';

/* ---------- auth ---------- */

export const loginSchema = z
  .object({
    email: z
      .string()
      .max(254)
      .transform((s) => s.trim().toLowerCase())
      .pipe(z.email()),
    password: z.string().min(1).max(LIMITS.passwordMax),
  })
  .strict();
export type LoginInput = z.infer<typeof loginSchema>;

export const meSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  categories: z.array(categorySchema),
  locale: localeSchema,
});
export type Me = z.infer<typeof meSchema>;

/* ---------- tickets ---------- */

const bodySchema = textSchema(1, LIMITS.bodyMax).refine((s) => s.trim().length > 0, {
  message: 'body must not be blank',
});
const attachmentIds = z.array(uuidSchema).max(LIMITS.attachmentsPerMessage);

/** Customer-facing creation. `urgent` is not selectable. */
export const createTicketSchema = z
  .object({
    subject: subjectSchema,
    category: categorySchema,
    priority: customerPrioritySchema.default('normal'),
    body: bodySchema,
    attachmentIds: attachmentIds.default([]),
    /** Client-generated id for the first message (idempotent create). */
    clientMessageId: uuidSchema,
  })
  .strict();
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

/** Staff may create on behalf with any priority; same shape but `urgent` allowed. */
export const staffCreateTicketSchema = createTicketSchema
  .extend({ priority: prioritySchema.default('normal') })
  .strict();

export const patchTicketSchema = z
  .object({
    /** Optimistic lock: version the client last saw. */
    version: z.number().int().min(1),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    category: categorySchema.optional(),
    assigneeId: uuidSchema.nullable().optional(),
    tags: tagsSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.status !== undefined ||
      v.priority !== undefined ||
      v.category !== undefined ||
      v.assigneeId !== undefined ||
      v.tags !== undefined,
    { message: 'at least one field to change is required' },
  );
export type PatchTicketInput = z.infer<typeof patchTicketSchema>;

export const createMessageSchema = z
  .object({
    /** Created on the client; a repeat with the same id never creates a second message. */
    id: uuidSchema,
    kind: messageKindSchema.default('public'),
    body: bodySchema,
    attachmentIds: attachmentIds.default([]),
    /** Optional status chosen together with the reply (“send and wait”, “send and resolve”). */
    setStatus: z.enum(['pending', 'resolved']).optional(),
  })
  .strict()
  .refine((v) => !(v.kind === 'internal' && v.setStatus !== undefined), {
    message: 'an internal note cannot change status',
    path: ['setStatus'],
  });
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const ratingSchema = z
  .object({
    score: z.number().int().min(1).max(5),
    comment: textSchema(0, 2000).optional(),
  })
  .strict();
export type RatingInput = z.infer<typeof ratingSchema>;

/* ---------- list / search ---------- */

export const assigneeFilterSchema = z.union([z.literal('me'), z.literal('none'), uuidSchema]);

const listTicketsQueryBase = z
  .object({
    status: csvArray(statusSchema).optional(),
    priority: csvArray(prioritySchema).optional(),
    category: csvArray(categorySchema).optional(),
    assignee: assigneeFilterSchema.optional(),
    slaBreached: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    tags: csvArray(z.string().min(1).max(LIMITS.tagMax)).optional(),
    createdFrom: isoDateTimeSchema.optional(),
    createdTo: isoDateTimeSchema.optional(),
    q: z.string().trim().min(1).max(LIMITS.searchMax).optional(),
    sort: ticketSortSchema.default('created'),
    order: z.enum(['asc', 'desc']).default('desc'),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
  })
  .strict();

export const listTicketsQuerySchema = listTicketsQueryBase.refine(
  (v) => !v.createdFrom || !v.createdTo || v.createdFrom <= v.createdTo,
  {
    message: 'createdFrom must not be after createdTo',
    path: ['createdFrom'],
  },
);
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

/* ---------- bulk ---------- */

const bulkIds = z
  .array(uuidSchema)
  .min(1)
  .max(LIMITS.bulkMax)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'ids must be unique' });

export const bulkActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), assigneeId: uuidSchema.nullable() }).strict(),
  z.object({ action: z.literal('setStatus'), status: statusSchema }).strict(),
  z.object({ action: z.literal('setPriority'), priority: prioritySchema }).strict(),
  z
    .object({
      action: z.literal('setTags'),
      mode: z.enum(['add', 'remove', 'replace']),
      tags: tagsSchema,
    })
    .strict(),
]);

export const bulkRequestSchema = z.object({ ids: bulkIds, operation: bulkActionSchema }).strict();
export type BulkRequest = z.infer<typeof bulkRequestSchema>;

export const BULK_SKIP_REASONS = [
  'not_found_or_forbidden',
  'invalid_transition',
  'closed',
  'unchanged',
  'assignee_not_eligible',
] as const;
export const bulkResultSchema = z.object({
  results: z.array(
    z.discriminatedUnion('ok', [
      z.object({ id: uuidSchema, ok: z.literal(true) }),
      z.object({ id: uuidSchema, ok: z.literal(false), reason: z.enum(BULK_SKIP_REASONS) }),
    ]),
  ),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;

/* ---------- canned responses, SLA, saved views ---------- */

export const cannedResponseSchema = z
  .object({
    title: textSchema(1, 120),
    /** Supports `{{customer_name}}` and `{{ticket_number}}`. */
    body: textSchema(1, LIMITS.bodyMax),
    category: categorySchema.nullable().default(null),
  })
  .strict();
export type CannedResponseInput = z.infer<typeof cannedResponseSchema>;

export const TEMPLATE_VARIABLES = ['customer_name', 'ticket_number'] as const;

export const slaPolicySchema = z
  .object({
    priority: prioritySchema,
    firstResponseMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 30),
    resolutionMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 90),
    /** `urgent` counts wall-clock time; others count business hours. */
    businessHours: z.boolean(),
  })
  .strict()
  .refine((v) => v.resolutionMinutes >= v.firstResponseMinutes, {
    message: 'resolution must not be shorter than first response',
    path: ['resolutionMinutes'],
  });
export type SlaPolicyInput = z.infer<typeof slaPolicySchema>;

export const slaSettingsSchema = z
  .object({ policies: z.array(slaPolicySchema).length(4) })
  .strict()
  .refine((v) => new Set(v.policies.map((p) => p.priority)).size === 4, {
    message: 'exactly one policy per priority',
    path: ['policies'],
  });

export const savedViewSchema = z
  .object({
    name: textSchema(1, 60),
    query: listTicketsQueryBase.omit({ cursor: true, limit: true }).partial(),
  })
  .strict();

/* ---------- stats, notifications, presence ---------- */

export const statsQuerySchema = z
  .object({ from: isoDateTimeSchema, to: isoDateTimeSchema })
  .strict()
  .refine((v) => v.from < v.to, { message: 'from must be before to', path: ['from'] });

export const NOTIFICATION_TYPES = [
  'assigned',
  'customer_replied',
  'sla_warning',
  'sla_breached',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export const markReadSchema = z.object({ ids: z.array(uuidSchema).min(1).max(200) }).strict();

export const presenceSchema = z.object({ typing: z.boolean() }).strict();

/* ---------- SSE events ---------- */

const ticketRef = z.object({ ticketId: uuidSchema, number: z.string() });
export const sseEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.created'),
    ticketId: uuidSchema,
    messageId: uuidSchema,
    kind: messageKindSchema,
  }),
  z.object({
    type: z.literal('ticket.changed'),
    ticketId: uuidSchema,
    /** Absent for changes that do not bump the version (SLA marks). */
    version: z.number().int().optional(),
    changed: z.array(z.string()),
  }),
  z.object({ type: z.literal('ticket.created'), ticketId: uuidSchema }),
  z.object({
    type: z.literal('notification.created'),
    notificationId: uuidSchema,
    kind: notificationTypeSchema,
    ...ticketRef.shape,
  }),
  z.object({
    type: z.literal('presence'),
    ticketId: uuidSchema,
    userId: uuidSchema,
    name: z.string(),
    typing: z.boolean(),
  }),
]);
export type SseEvent = z.infer<typeof sseEventSchema>;
