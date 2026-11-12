import { z } from 'zod';

export const ROLES = ['customer', 'agent', 'lead'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'] as const;
export const statusSchema = z.enum(STATUSES);
export type TicketStatus = z.infer<typeof statusSchema>;

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const prioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof prioritySchema>;

/** Customers may pick only these; `urgent` is staff-only. */
export const CUSTOMER_PRIORITIES = ['low', 'normal', 'high'] as const;
export const customerPrioritySchema = z.enum(CUSTOMER_PRIORITIES);

/** Reference list of categories (справочник): payment, delivery, account, technical, other. */
export const CATEGORIES = ['payment', 'delivery', 'account', 'technical', 'other'] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof categorySchema>;

export const MESSAGE_KINDS = ['public', 'internal'] as const;
export const messageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const LOCALES = ['uk', 'en'] as const;
export const localeSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof localeSchema>;

export const TICKET_SORTS = ['sla', 'created', 'updated'] as const;
export const ticketSortSchema = z.enum(TICKET_SORTS);
export type TicketSort = z.infer<typeof ticketSortSchema>;

export const LIMITS = {
  subjectMax: 200,
  bodyMax: 20_000,
  tagMax: 40,
  tagsMax: 20,
  attachmentsPerMessage: 5,
  attachmentMaxBytes: 10 * 1024 * 1024,
  bulkMax: 200,
  pageSizeMax: 100,
  pageSizeDefault: 50,
  searchMax: 200,
  passwordMax: 128,
} as const;

/** MIME types accepted for attachments (verified by content on the server, not by extension). */
export const ALLOWED_ATTACHMENT_MIME = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
] as const;
