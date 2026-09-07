ALTER TABLE "finding" ADD COLUMN "end_line" integer;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "result_summary" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "result_stopped_by" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "result_disproved_hypothesis_count" integer;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "result_usage" jsonb;