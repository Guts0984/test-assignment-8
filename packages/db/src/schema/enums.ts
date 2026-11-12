import { pgEnum } from 'drizzle-orm/pg-core';
import {
  LOCALES,
  MESSAGE_KINDS,
  NOTIFICATION_TYPES,
  PRIORITIES,
  ROLES,
  STATUSES,
} from '@helpdesk/shared';

// Enum value order is meaningful for `priority`: low < normal < high < urgent (ORDER BY priority DESC).
export const roleEnum = pgEnum('role', ROLES);
export const statusEnum = pgEnum('ticket_status', STATUSES);
export const priorityEnum = pgEnum('priority', PRIORITIES);
export const messageKindEnum = pgEnum('message_kind', MESSAGE_KINDS);
export const localeEnum = pgEnum('locale', LOCALES);
export const notificationTypeEnum = pgEnum('notification_type', NOTIFICATION_TYPES);
export const jobStatusEnum = pgEnum('job_status', ['queued', 'running', 'done', 'failed']);
export const ticketEventFieldEnum = pgEnum('ticket_event_field', [
  'created',
  'status',
  'priority',
  'assignee',
  'category',
  'tags',
]);
