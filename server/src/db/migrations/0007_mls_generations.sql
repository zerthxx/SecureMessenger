ALTER TABLE "conversations" ADD COLUMN "mls_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "mls_generation_device_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "previous_refresh_token_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "previous_refresh_token_valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "mls_generation" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ciphertext_sha256" "bytea";--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_id_ciphertext_sha256_idx" ON "messages" USING btree ("conversation_id","ciphertext_sha256");--> statement-breakpoint
-- Conversations whose MLS group was set up before generations existed
-- (there is a Welcome for them) are on generation 1; the rest have none yet.
UPDATE "conversations" SET "mls_generation" = 1 WHERE EXISTS (SELECT 1 FROM "messages" m WHERE m."conversation_id" = "conversations"."id" AND m."message_type" = 'welcome');
