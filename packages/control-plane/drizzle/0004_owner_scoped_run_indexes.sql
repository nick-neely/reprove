DROP INDEX "run_one_live_per_pull_request";--> statement-breakpoint
DROP INDEX "run_one_automatic_per_head";--> statement-breakpoint
CREATE UNIQUE INDEX "run_one_live_per_pull_request" ON "run" USING btree ("owner_id","repository_id","pull_request_number") WHERE "run"."status" in ('queued', 'claimed', 'executing');--> statement-breakpoint
CREATE UNIQUE INDEX "run_one_automatic_per_head" ON "run" USING btree ("owner_id","repository_id","pull_request_number","head_sha") WHERE "run"."trigger" = 'automatic';