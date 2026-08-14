-- AI chat v2: persisted conversations for the workspace AI drawer, and the
-- verified-publisher trust mark the chat's store-catalog tool filters on.

ALTER TABLE "accounts" ADD COLUMN "verified_publisher_at" timestamp with time zone;

CREATE TABLE "ai_chats" (
	"id" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
	"frame_id" uuid REFERENCES "frames"("id") ON DELETE set null,
	"context_type" text DEFAULT 'frame' NOT NULL,
	"context_id" text,
	"title" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX ai_chats_account_idx ON ai_chats (account_id, updated_at);
CREATE INDEX ai_chats_frame_idx ON ai_chats (frame_id);

CREATE TABLE "ai_chat_messages" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"chat_id" uuid NOT NULL REFERENCES "ai_chats"("id") ON DELETE cascade,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX ai_chat_messages_chat_idx ON ai_chat_messages (chat_id, id);
