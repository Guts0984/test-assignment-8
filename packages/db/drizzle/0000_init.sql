CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('uk', 'en');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('public', 'internal');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('assigned', 'customer_replied', 'sla_warning', 'sla_breached');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('customer', 'agent', 'lead');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('new', 'open', 'pending', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ticket_event_field" AS ENUM('created', 'status', 'priority', 'assignee', 'category', 'tags');--> statement-breakpoint
CREATE TABLE "agent_categories" (
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	CONSTRAINT "agent_categories_user_id_category_pk" PRIMARY KEY("user_id","category")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"message_id" uuid,
	"original_name" varchar(255) NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_size" CHECK ("attachments"."size_bytes" BETWEEN 1 AND 10485760),
	CONSTRAINT "attachments_mime" CHECK ("attachments"."mime" IN ('image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain'))
);
--> statement-breakpoint
CREATE TABLE "canned_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(120) NOT NULL,
	"body" text NOT NULL,
	"category" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canned_title_not_blank" CHECK ("canned_responses"."title" ~ '[^[:space:]]')
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"slug" text PRIMARY KEY NOT NULL,
	"name_uk" text NOT NULL,
	"name_en" text NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"name" text PRIMARY KEY NOT NULL,
	"value" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"ticket_id" uuid,
	"target_user_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"dedupe_key" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_attempts" CHECK ("jobs"."attempts" >= 0 AND "jobs"."attempts" <= "jobs"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "message_kind" DEFAULT 'public' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED,
	CONSTRAINT "messages_body_len" CHECK ("messages"."body" ~ '[^[:space:]]' AND char_length("messages"."body") <= 20000)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"ticket_id" uuid NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone,
	CONSTRAINT "rate_limits_count_nonneg" CHECK ("rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"ticket_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_score" CHECK ("ratings"."score" BETWEEN 1 AND 5),
	CONSTRAINT "ratings_comment_len" CHECK ("ratings"."comment" IS NULL OR length("ratings"."comment") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"query" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"priority" "priority" PRIMARY KEY NOT NULL,
	"first_response_minutes" integer NOT NULL,
	"resolution_minutes" integer NOT NULL,
	"business_hours" boolean NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_first_positive" CHECK ("sla_policies"."first_response_minutes" > 0),
	CONSTRAINT "sla_resolution_gte_first" CHECK ("sla_policies"."resolution_minutes" >= "sla_policies"."first_response_minutes")
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"actor_id" uuid,
	"field" "ticket_event_field" NOT NULL,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_presence" (
	"ticket_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ticket_presence_ticket_id_user_id_pk" PRIMARY KEY("ticket_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_reads" (
	"user_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_reads_user_id_ticket_id_pk" PRIMARY KEY("user_id","ticket_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"subject" varchar(200) NOT NULL,
	"category" text NOT NULL,
	"priority" "priority" DEFAULT 'normal' NOT NULL,
	"status" "ticket_status" DEFAULT 'new' NOT NULL,
	"customer_id" uuid NOT NULL,
	"assignee_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"linked_ticket_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_public_message_at" timestamp with time zone,
	"first_response_due" timestamp with time zone NOT NULL,
	"resolution_due" timestamp with time zone NOT NULL,
	"first_responded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"sla_paused_at" timestamp with time zone,
	"first_response_remaining_min" integer,
	"resolution_remaining_min" integer,
	"first_response_warned_at" timestamp with time zone,
	"resolution_warned_at" timestamp with time zone,
	"first_response_breached_at" timestamp with time zone,
	"resolution_breached_at" timestamp with time zone,
	"sla_due_at" timestamp with time zone GENERATED ALWAYS AS (CASE
        WHEN status IN ('pending', 'resolved', 'closed') THEN NULL
        WHEN first_responded_at IS NULL THEN first_response_due
        ELSE resolution_due
      END) STORED,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(subject, ''))) STORED,
	CONSTRAINT "tickets_subject_len" CHECK ("tickets"."subject" ~ '[^[:space:]]' AND char_length("tickets"."subject") <= 200),
	CONSTRAINT "tickets_version_positive" CHECK ("tickets"."version" >= 1),
	CONSTRAINT "tickets_number_positive" CHECK ("tickets"."number" > 0),
	CONSTRAINT "tickets_tags_not_null_elems" CHECK (array_position("tickets"."tags", NULL) IS NULL),
	CONSTRAINT "tickets_tags_max" CHECK (cardinality("tickets"."tags") <= 20),
	CONSTRAINT "tickets_not_self_linked" CHECK ("tickets"."linked_ticket_id" IS NULL OR "tickets"."linked_ticket_id" <> "tickets"."id"),
	CONSTRAINT "tickets_resolution_after_first" CHECK ("tickets"."resolution_due" >= "tickets"."first_response_due"),
	CONSTRAINT "tickets_pause_consistent" CHECK ("tickets"."sla_paused_at" IS NOT NULL OR ("tickets"."first_response_remaining_min" IS NULL AND "tickets"."resolution_remaining_min" IS NULL)),
	CONSTRAINT "tickets_remaining_nonneg" CHECK (coalesce("tickets"."first_response_remaining_min", 0) >= 0 AND coalesce("tickets"."resolution_remaining_min", 0) >= 0),
	CONSTRAINT "tickets_closed_has_time" CHECK ("tickets"."status" <> 'closed' OR "tickets"."closed_at" IS NOT NULL),
	CONSTRAINT "tickets_resolved_has_time" CHECK ("tickets"."status" NOT IN ('resolved', 'closed') OR "tickets"."resolved_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"name" varchar(120) NOT NULL,
	"role" "role" NOT NULL,
	"password_hash" text NOT NULL,
	"locale" "locale" DEFAULT 'uk' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_name_not_blank" CHECK ("users"."name" ~ '[^[:space:]]')
);
--> statement-breakpoint
ALTER TABLE "agent_categories" ADD CONSTRAINT "agent_categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_categories" ADD CONSTRAINT "agent_categories_category_categories_slug_fk" FOREIGN KEY ("category") REFERENCES "public"."categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_category_categories_slug_fk" FOREIGN KEY ("category") REFERENCES "public"."categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_presence" ADD CONSTRAINT "ticket_presence_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_presence" ADD CONSTRAINT "ticket_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reads" ADD CONSTRAINT "ticket_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reads" ADD CONSTRAINT "ticket_reads_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_categories_slug_fk" FOREIGN KEY ("category") REFERENCES "public"."categories"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_linked_ticket_id_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_categories_cat_idx" ON "agent_categories" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_storage_key_uq" ON "attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id") WHERE "attachments"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "attachments_orphans_idx" ON "attachments" USING btree ("created_at") WHERE "attachments"."message_id" IS NULL;--> statement-breakpoint
CREATE INDEX "event_log_created_idx" ON "event_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_lease_idx" ON "jobs" USING btree ("locked_until") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" IS NOT NULL AND "jobs"."status" IN ('queued','running');--> statement-breakpoint
CREATE UNIQUE INDEX "messages_author_client_uq" ON "messages" USING btree ("author_id","client_id");--> statement-breakpoint
CREATE INDEX "messages_ticket_idx" ON "messages" USING btree ("ticket_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messages_search_gin" ON "messages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("user_id","ticket_id","dedupe_key") WHERE "notifications"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "ratings_created_idx" ON "ratings" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_user_name_uq" ON "saved_views" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ticket_presence_expires_idx" ON "ticket_presence" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number_uq" ON "tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "tickets_queue_idx" ON "tickets" USING btree ("category","priority" DESC,"sla_due_at" ASC,"created_at") WHERE "tickets"."assignee_id" IS NULL AND "tickets"."status" IN ('new', 'open');--> statement-breakpoint
CREATE INDEX "tickets_assignee_status_idx" ON "tickets" USING btree ("assignee_id","status") WHERE "tickets"."assignee_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tickets_customer_idx" ON "tickets" USING btree ("customer_id","updated_at" DESC,"id");--> statement-breakpoint
CREATE INDEX "tickets_created_idx" ON "tickets" USING btree ("created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "tickets_updated_idx" ON "tickets" USING btree ("updated_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "tickets_sla_due_idx" ON "tickets" USING btree ("sla_due_at","id") WHERE "tickets"."sla_due_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tickets_status_cat_idx" ON "tickets" USING btree ("status","category");--> statement-breakpoint
CREATE INDEX "tickets_breached_idx" ON "tickets" USING btree ("id") WHERE "tickets"."first_response_breached_at" IS NOT NULL OR "tickets"."resolution_breached_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tickets_tags_gin" ON "tickets" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "tickets_search_gin" ON "tickets" USING gin ("search");--> statement-breakpoint
CREATE INDEX "tickets_resolved_idx" ON "tickets" USING btree ("resolved_at") WHERE "tickets"."status" = 'resolved';--> statement-breakpoint
CREATE INDEX "tickets_sla_scan_idx" ON "tickets" USING btree ("first_response_due","resolution_due") WHERE "tickets"."status" IN ('new', 'open');--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");