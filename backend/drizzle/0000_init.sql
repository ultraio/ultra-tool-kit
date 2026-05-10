CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE "action_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"action_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"embedding_768" vector(768),
	"embedding_1536" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_chunks_kind_chk" CHECK ("action_chunks"."kind" in ('summary', 'rules', 'example'))
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"contract_id" bigint NOT NULL,
	"name" text NOT NULL,
	"fields" jsonb NOT NULL,
	"rules" jsonb NOT NULL,
	"default_auth" jsonb,
	"is_admin" boolean DEFAULT false NOT NULL,
	"description" text,
	"examples" jsonb,
	"source_ref" text,
	"unresolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid,
	"role" text NOT NULL,
	"content" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_role_chk" CHECK ("chat_messages"."role" in ('user', 'assistant', 'system'))
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"account" text,
	"endpoint" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"display_name" text,
	"source_repo" text,
	"description" text,
	"abi_hash" text,
	"abi_fetched_at" timestamp with time zone,
	"abi_chain_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_account_unique" UNIQUE("account")
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kind" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read" integer DEFAULT 0 NOT NULL,
	"cache_write" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 8),
	"request_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_chunks" ADD CONSTRAINT "action_chunks_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actions_contract_name_uq" ON "actions" USING btree ("contract_id","name");--> statement-breakpoint
CREATE INDEX "action_chunks_embedding_768_ivfflat" ON "action_chunks" USING ivfflat ("embedding_768" vector_cosine_ops) WITH (lists = 100);--> statement-breakpoint
CREATE INDEX "action_chunks_embedding_1536_ivfflat" ON "action_chunks" USING ivfflat ("embedding_1536" vector_cosine_ops) WITH (lists = 100);