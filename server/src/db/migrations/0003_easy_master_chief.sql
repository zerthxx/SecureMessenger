CREATE TYPE "public"."message_type" AS ENUM('application', 'welcome');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "recipient_device_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "message_type" "message_type" DEFAULT 'application' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_device_id_devices_id_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_recipient_device_id_idx" ON "messages" USING btree ("recipient_device_id");