CREATE TABLE "device_key_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"public_key_package" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "mls_credential_public_key" "bytea";--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "identity_cross_signature" "bytea";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "identity_signing_public_key" "bytea";--> statement-breakpoint
ALTER TABLE "device_key_packages" ADD CONSTRAINT "device_key_packages_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_key_packages_device_id_idx" ON "device_key_packages" USING btree ("device_id");