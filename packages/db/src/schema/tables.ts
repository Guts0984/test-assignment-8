import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { LIMITS } from '@helpdesk/shared';
import {
  jobStatusEnum,
  localeEnum,
  messageKindEnum,
  notificationTypeEnum,
  priorityEnum,
  roleEnum,
  statusEnum,
  ticketEventFieldEnum,
} from './enums';
import { tsvector, tstz } from './types';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => tstz('created_at').notNull().defaultNow();

/* ------------------------------------------------------------------ reference data */

export const categories = pgTable('categories', {
  slug: text('slug').primaryKey(),
  nameUk: text('name_uk').notNull(),
  nameEn: text('name_en').notNull(),
  sortOrder: integer('sort_order').notNull(),
});

export const slaPolicies = pgTable(
  'sla_policies',
  {
    priority: priorityEnum('priority').primaryKey(),
    firstResponseMinutes: integer('first_response_minutes').notNull(),
    resolutionMinutes: integer('resolution_minutes').notNull(),
    /** false → wall-clock minutes (urgent). */
    businessHours: boolean('business_hours').notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('sla_first_positive', sql`${t.firstResponseMinutes} > 0`),
    check('sla_resolution_gte_first', sql`${t.resolutionMinutes} >= ${t.firstResponseMinutes}`),
  ],
);

/* ------------------------------------------------------------------ users & sessions */

export const users = pgTable(
  'users',
  {
    id: id(),
    email: varchar('email', { length: 254 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    role: roleEnum('role').notNull(),
    passwordHash: text('password_hash').notNull(),
    locale: localeEnum('locale').notNull().default('uk'),
    disabled: boolean('disabled').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_name_not_blank', sql`${t.name} ~ '[^[:space:]]'`),
  ],
);

export const agentCategories = pgTable(
  'agent_categories',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category')
      .notNull()
      .references(() => categories.slug),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.category] }),
    index('agent_categories_cat_idx').on(t.category),
  ],
);

/** `id` stores sha256(token); the raw token only ever lives in the cookie. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/**
 * Generic fixed-window counters, atomic via INSERT … ON CONFLICT. Keys are namespaced by the API
 * (`ip:1.2.3.4:api`, `login:ip+email:…`). `blocked_until` implements lockouts.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    windowStart: tstz('window_start').notNull(),
    blockedUntil: tstz('blocked_until'),
  },
  (t) => [
    index('rate_limits_window_idx').on(t.windowStart),
    check('rate_limits_count_nonneg', sql`${t.count} >= 0`),
  ],
);

/* ------------------------------------------------------------------ tickets */

/** Named gap-free counters; ticket numbers are allocated with UPDATE … RETURNING in the creating tx. */
export const counters = pgTable('counters', {
  name: text('name').primaryKey(),
  value: bigint('value', { mode: 'number' }).notNull(),
});

export const tickets = pgTable(
  'tickets',
  {
    id: id(),
    number: integer('number').notNull(),
    subject: varchar('subject', { length: LIMITS.subjectMax }).notNull(),
    category: text('category')
      .notNull()
      .references(() => categories.slug),
    priority: priorityEnum('priority').notNull().default('normal'),
    status: statusEnum('status').notNull().default('new'),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => users.id),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Optimistic-lock version; every successful change increments it. */
    version: integer('version').notNull().default(1),
    /** Ticket this one continues (customer replied to a closed ticket). */
    linkedTicketId: uuid('linked_ticket_id').references((): AnyPgColumn => tickets.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    lastPublicMessageAt: tstz('last_public_message_at'),

    // --- SLA ---
    firstResponseDue: tstz('first_response_due').notNull(),
    resolutionDue: tstz('resolution_due').notNull(),
    firstRespondedAt: tstz('first_responded_at'),
    resolvedAt: tstz('resolved_at'),
    closedAt: tstz('closed_at'),
    /** Set while status = pending: minutes left on each deadline when the clock stopped. */
    slaPausedAt: tstz('sla_paused_at'),
    firstResponseRemainingMin: integer('first_response_remaining_min'),
    resolutionRemainingMin: integer('resolution_remaining_min'),
    // Marked exactly once by the background job:
    firstResponseWarnedAt: tstz('first_response_warned_at'),
    resolutionWarnedAt: tstz('resolution_warned_at'),
    firstResponseBreachedAt: tstz('first_response_breached_at'),
    resolutionBreachedAt: tstz('resolution_breached_at'),
    /** The deadline that currently matters, NULL when the clock is not running. Sort/filter key. */
    slaDueAt: tstz('sla_due_at').generatedAlwaysAs(
      sql`CASE
        WHEN status IN ('pending', 'resolved', 'closed') THEN NULL
        WHEN first_responded_at IS NULL THEN first_response_due
        ELSE resolution_due
      END`,
    ),
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('simple', coalesce(subject, ''))`),
  },
  (t) => [
    uniqueIndex('tickets_number_uq').on(t.number),
    check(
      'tickets_subject_len',
      sql`${t.subject} ~ '[^[:space:]]' AND char_length(${t.subject}) <= ${sql.raw(String(LIMITS.subjectMax))}`,
    ),
    check('tickets_version_positive', sql`${t.version} >= 1`),
    check('tickets_number_positive', sql`${t.number} > 0`),
    check('tickets_tags_not_null_elems', sql`array_position(${t.tags}, NULL) IS NULL`),
    check('tickets_tags_max', sql`cardinality(${t.tags}) <= ${sql.raw(String(LIMITS.tagsMax))}`),
    check(
      'tickets_not_self_linked',
      sql`${t.linkedTicketId} IS NULL OR ${t.linkedTicketId} <> ${t.id}`,
    ),
    check('tickets_resolution_after_first', sql`${t.resolutionDue} >= ${t.firstResponseDue}`),
    // Remaining-minutes are only meaningful while the clock is paused.
    check(
      'tickets_pause_consistent',
      sql`${t.slaPausedAt} IS NOT NULL OR (${t.firstResponseRemainingMin} IS NULL AND ${t.resolutionRemainingMin} IS NULL)`,
    ),
    check(
      'tickets_remaining_nonneg',
      sql`coalesce(${t.firstResponseRemainingMin}, 0) >= 0 AND coalesce(${t.resolutionRemainingMin}, 0) >= 0`,
    ),
    check('tickets_closed_has_time', sql`${t.status} <> 'closed' OR ${t.closedAt} IS NOT NULL`),
    check(
      'tickets_resolved_has_time',
      sql`${t.status} NOT IN ('resolved', 'closed') OR ${t.resolvedAt} IS NOT NULL`,
    ),

    // Queue ("take next"): unassigned, still needing work; ordered by priority then deadline.
    index('tickets_queue_idx')
      .on(t.category, sql`${t.priority} DESC`, sql`${t.slaDueAt} ASC`, t.createdAt)
      .where(sql`${t.assigneeId} IS NULL AND ${t.status} IN ('new', 'open')`),
    index('tickets_assignee_status_idx')
      .on(t.assigneeId, t.status)
      .where(sql`${t.assigneeId} IS NOT NULL`),
    index('tickets_customer_idx').on(t.customerId, sql`${t.updatedAt} DESC`, t.id),
    // Keyset-pagination sort keys (id is the tie-breaker):
    index('tickets_created_idx').on(sql`${t.createdAt} DESC`, sql`${t.id} DESC`),
    index('tickets_updated_idx').on(sql`${t.updatedAt} DESC`, sql`${t.id} DESC`),
    index('tickets_sla_due_idx')
      .on(t.slaDueAt, t.id)
      .where(sql`${t.slaDueAt} IS NOT NULL`),
    index('tickets_status_cat_idx').on(t.status, t.category),
    index('tickets_breached_idx')
      .on(t.id)
      .where(
        sql`${t.firstResponseBreachedAt} IS NOT NULL OR ${t.resolutionBreachedAt} IS NOT NULL`,
      ),
    index('tickets_tags_gin').using('gin', t.tags),
    index('tickets_search_gin').using('gin', t.search),
    // Background jobs: find work without scanning everything.
    index('tickets_resolved_idx')
      .on(t.resolvedAt)
      .where(sql`${t.status} = 'resolved'`),
    index('tickets_sla_scan_idx')
      .on(t.firstResponseDue, t.resolutionDue)
      .where(sql`${t.status} IN ('new', 'open')`),
  ],
);

export const ticketReads = pgTable(
  'ticket_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    lastReadAt: tstz('last_read_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.ticketId] })],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    /** Idempotency key generated by the client; unique per author, so ids cannot collide across users. */
    clientId: uuid('client_id').notNull(),
    kind: messageKindEnum('kind').notNull().default('public'),
    body: text('body').notNull(),
    createdAt: createdAt(),
    search: tsvector('search').generatedAlwaysAs(sql`to_tsvector('simple', coalesce(body, ''))`),
  },
  (t) => [
    uniqueIndex('messages_author_client_uq').on(t.authorId, t.clientId),
    check(
      'messages_body_len',
      sql`${t.body} ~ '[^[:space:]]' AND char_length(${t.body}) <= ${sql.raw(String(LIMITS.bodyMax))}`,
    ),
    index('messages_ticket_idx').on(t.ticketId, t.createdAt, t.id),
    index('messages_search_gin').using('gin', t.search),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    /** NULL until the message that carries it is sent; orphans are purged after 24 h. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    originalName: varchar('original_name', { length: 255 }).notNull(),
    /** Detected from file content, never from the extension. */
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Random name on disk — never derived from user input. */
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('attachments_storage_key_uq').on(t.storageKey),
    check(
      'attachments_size',
      sql`${t.sizeBytes} BETWEEN 1 AND ${sql.raw(String(LIMITS.attachmentMaxBytes))}`,
    ),
    check(
      'attachments_mime',
      sql`${t.mime} IN ('image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain')`,
    ),
    index('attachments_message_idx')
      .on(t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),
    index('attachments_orphans_idx')
      .on(t.createdAt)
      .where(sql`${t.messageId} IS NULL`),
  ],
);

/** Audit trail: who changed what and when. */
export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** NULL = the system (background job, automatic transition). */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    field: ticketEventFieldEnum('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    createdAt: createdAt(),
  },
  (t) => [index('ticket_events_ticket_idx').on(t.ticketId, t.createdAt, t.id)],
);

export const ratings = pgTable(
  'ratings',
  {
    ticketId: uuid('ticket_id')
      .primaryKey()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => users.id),
    score: integer('score').notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
  },
  (t) => [
    check('ratings_score', sql`${t.score} BETWEEN 1 AND 5`),
    check('ratings_comment_len', sql`${t.comment} IS NULL OR length(${t.comment}) <= 2000`),
    index('ratings_created_idx').on(t.createdAt),
  ],
);

/* ------------------------------------------------------------------ staff tools */

export const cannedResponses = pgTable(
  'canned_responses',
  {
    id: id(),
    title: varchar('title', { length: 120 }).notNull(),
    body: text('body').notNull(),
    category: text('category').references(() => categories.slug),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [check('canned_title_not_blank', sql`${t.title} ~ '[^[:space:]]'`)],
);

export const savedViews = pgTable(
  'saved_views',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    query: jsonb('query').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('saved_views_user_name_uq').on(t.userId, t.name)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** Prevents duplicate notifications for the same event (e.g. `sla_warning:first_response`). */
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    readAt: tstz('read_at'),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, sql`${t.createdAt} DESC`),
    index('notifications_unread_idx')
      .on(t.userId)
      .where(sql`${t.readAt} IS NULL`),
    uniqueIndex('notifications_dedupe_uq')
      .on(t.userId, t.ticketId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
  ],
);

/* ------------------------------------------------------------------ realtime & jobs */

/** "Ivan is replying" — rows expire, a job/lazy purge removes stale ones. */
export const ticketPresence = pgTable(
  'ticket_presence',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ticketId, t.userId] }),
    index('ticket_presence_expires_idx').on(t.expiresAt),
  ],
);

/** Durable event log behind SSE (`Last-Event-ID` resume). `target_user_id` NULL = staff-wide. */
export const eventLog = pgTable(
  'event_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    ticketId: uuid('ticket_id'),
    targetUserId: uuid('target_user_id'),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('event_log_created_idx').on(t.createdAt)],
);

/** Job queue on PostgreSQL: claimed with FOR UPDATE SKIP LOCKED, protected by a lease. */
export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: jobStatusEnum('status').notNull().default('queued'),
    runAt: tstz('run_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedBy: text('locked_by'),
    lockedUntil: tstz('locked_until'),
    /** Unique while not finished → one scheduled instance per logical job, even across restarts. */
    dedupeKey: text('dedupe_key'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    index('jobs_due_idx')
      .on(t.runAt)
      .where(sql`${t.status} = 'queued'`),
    index('jobs_lease_idx')
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'running'`),
    uniqueIndex('jobs_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('queued','running')`),
    check('jobs_attempts', sql`${t.attempts} >= 0 AND ${t.attempts} <= ${t.maxAttempts}`),
  ],
);
