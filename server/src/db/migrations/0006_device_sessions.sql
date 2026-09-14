ALTER TABLE "devices" ADD COLUMN "model" varchar(100);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "os_version" varchar(50);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "app_version" varchar(50);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_ip_prefix" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "session_ttl_days" integer DEFAULT 180 NOT NULL;