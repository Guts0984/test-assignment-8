import { z } from 'zod';
import {
  categorySchema,
  messageKindSchema,
  prioritySchema,
  roleSchema,
  statusSchema,
} from './enums';
import { isoDateTimeSchema, uuidSchema } from './primitives';
import { ticketEventFieldValues } from './events';

/** Shapes the API returns (the web app and MSW handlers use these types). */

export const userRefSchema = z.object({ id: uuidSchema, name: z.string() });
export type UserRef = z.infer<typeof userRefSchema>;

export const slaInfoSchema = z.object({
  firstResponseDue: isoDateTimeSchema,
  resolutionDue: isoDateTimeSchema,
  firstRespondedAt: isoDateTimeSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  /** The deadline that currently matters; null while paused / resolved / closed. */
  dueAt: isoDateTimeSchema.nullable(),
  pausedAt: isoDateTimeSchema.nullable(),
  firstResponseBreached: z.boolean(),
  resolutionBreached: z.boolean(),
  breached: z.boolean(),
});
export type SlaInfo = z.infer<typeof slaInfoSchema>;

export const ticketDtoSchema = z.object({
  id: uuidSchema,
  number: z.number().int(),
  /** `HD-1042` */
  code: z.string(),
  subject: z.string(),
  category: categorySchema,
  priority: prioritySchema,
  status: statusSchema,
  customer: userRefSchema,
  assignee: userRefSchema.nullable(),
  /** Always empty for customers (tags are staff metadata). */
  tags: z.array(z.string()),
  version: z.number().int(),
  linkedTicketId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  lastPublicMessageAt: isoDateTimeSchema.nullable(),
  /** Customers only: a staff reply arrived since the ticket was last opened. */
  unread: z.boolean(),
  /** null for customers: SLA is internal. */
  sla: slaInfoSchema.nullable(),
});
export type TicketDto = z.infer<typeof ticketDtoSchema>;

export const attachmentDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
});
export type AttachmentDto = z.infer<typeof attachmentDtoSchema>;

export const messageDtoSchema = z.object({
  id: uuidSchema,
  ticketId: uuidSchema,
  author: z.object({ id: uuidSchema, name: z.string(), role: roleSchema }),
  kind: messageKindSchema,
  body: z.string(),
  createdAt: isoDateTimeSchema,
  attachments: z.array(attachmentDtoSchema),
});
export type MessageDto = z.infer<typeof messageDtoSchema>;

export const ticketEventDtoSchema = z.object({
  id: z.number().int(),
  actor: userRefSchema.nullable(),
  field: z.enum(ticketEventFieldValues),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type TicketEventDto = z.infer<typeof ticketEventDtoSchema>;

export const ticketDetailSchema = z.object({
  ticket: ticketDtoSchema,
  messages: z.array(messageDtoSchema),
  /** Staff only; empty for customers. */
  events: z.array(ticketEventDtoSchema),
  rating: z.object({ score: z.number().int(), comment: z.string().nullable() }).nullable(),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

export const ticketListSchema = z.object({
  items: z.array(ticketDtoSchema),
  nextCursor: z.string().nullable(),
});
export type TicketList = z.infer<typeof ticketListSchema>;

export const messageResultSchema = z.object({
  message: messageDtoSchema,
  ticket: ticketDtoSchema,
  /** true when this request was a repeat of an earlier one (same client id): nothing new was created. */
  replayed: z.boolean(),
  /** Set when the customer replied to a closed ticket: a NEW ticket linked to the old one was created. */
  spawnedFrom: uuidSchema.nullable(),
});
export type MessageResult = z.infer<typeof messageResultSchema>;

export const cannedResponseDtoSchema = z.object({
  id: uuidSchema,
  title: z.string(),
  body: z.string(),
  category: categorySchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type CannedResponseDto = z.infer<typeof cannedResponseDtoSchema>;

export const agentDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  categories: z.array(categorySchema),
});
export type AgentDto = z.infer<typeof agentDtoSchema>;

export const notificationDtoSchema = z.object({
  id: uuidSchema,
  type: z.enum(['assigned', 'customer_replied', 'sla_warning', 'sla_breached']),
  ticket: z.object({ id: uuidSchema, code: z.string(), subject: z.string() }),
  createdAt: isoDateTimeSchema,
  readAt: isoDateTimeSchema.nullable(),
});
export type NotificationDto = z.infer<typeof notificationDtoSchema>;

export const notificationListSchema = z.object({
  items: z.array(notificationDtoSchema),
  unreadCount: z.number().int(),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

export const statsSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  created: z.number().int(),
  resolved: z.number().int(),
  /** Wall-clock seconds; null when there is nothing to average. */
  avgFirstResponseSeconds: z.number().nullable(),
  avgResolutionSeconds: z.number().nullable(),
  /** Share (0–100) of tickets created in the period that breached any SLA deadline. */
  slaBreachPercent: z.number().nullable(),
  avgRating: z.number().nullable(),
  ratingCount: z.number().int(),
  workload: z.array(
    z.object({
      agent: userRefSchema,
      active: z.number().int(),
      resolvedInPeriod: z.number().int(),
      breached: z.number().int(),
    }),
  ),
});
export type Stats = z.infer<typeof statsSchema>;
