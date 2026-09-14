CREATE TYPE "public"."birthday_visibility" AS ENUM('hidden', 'month_day', 'full');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" varchar(160);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "birthday" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "birthday_visibility" "birthday_visibility" DEFAULT 'month_day' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_id" uuid;