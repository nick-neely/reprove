ALTER TABLE "run" ALTER COLUMN "claimable_until" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "allow_hosted_fallback" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "resolved_config" jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "run_one_automatic_per_head" ON "run" USING btree ("repository_id","pull_request_number","head_sha") WHERE "run"."trigger" = 'automatic';