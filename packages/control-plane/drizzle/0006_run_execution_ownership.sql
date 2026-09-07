ALTER TABLE "run" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "execution_token" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "execution_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "worker_protocol_version" integer;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "worker_build_version" text;--> statement-breakpoint
CREATE INDEX "run_claimable_idx" ON "run" USING btree ("owner_id","status","claimable_until");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_credential_owner_secret_idx" ON "worker_credential" USING btree ("owner_id","secret_hash");