ALTER TABLE "run" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "failure_detail" jsonb;