CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" bigint NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "enrollment_code" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" bigint NOT NULL,
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"line" integer,
	"severity" text NOT NULL,
	"verification" text NOT NULL,
	"title" text,
	"body" text,
	"anchored_text" text,
	"evidence" jsonb,
	"patch" jsonb,
	"content_purged_at" timestamp with time zone,
	"bucket_key" text NOT NULL,
	"bucket_key_version" integer NOT NULL,
	"publication_disposition" text,
	"reconciliation" text
);
--> statement-breakpoint
ALTER TABLE "finding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ingress_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" bigint NOT NULL,
	"delivery_guid" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"installation_id" bigint,
	"repository_id" bigint,
	"repository_name_with_owner" text,
	"pull_request_number" integer,
	"state" text DEFAULT 'received' NOT NULL,
	"disposition" text,
	"retry_class" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingress_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "installation" (
	"id" bigint PRIMARY KEY NOT NULL,
	"owner_id" bigint NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "installation_owner_scoped_id" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "installation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "owner" (
	"id" bigint PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"type" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "owner" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "publication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" bigint NOT NULL,
	"run_id" uuid NOT NULL,
	"state" text NOT NULL,
	"github_review_id" bigint,
	"event" text,
	"applied_threshold" jsonb,
	"reconciled_against_run_id" uuid,
	"prior_reconciliation" jsonb,
	"attempts" jsonb,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "publication_one_per_run" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "publication" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "repository" (
	"id" bigint PRIMARY KEY NOT NULL,
	"owner_id" bigint NOT NULL,
	"installation_id" bigint,
	"name_with_owner" text NOT NULL,
	"in_scope" boolean DEFAULT true NOT NULL,
	CONSTRAINT "repository_owner_scoped_id" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "repository" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" bigint NOT NULL,
	"repository_id" bigint NOT NULL,
	"pull_request_number" integer NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text NOT NULL,
	"provenance" text NOT NULL,
	"provenance_basis" jsonb NOT NULL,
	"trigger" text NOT NULL,
	"harness" text NOT NULL,
	"model" text NOT NULL,
	"strategy" text NOT NULL,
	"autonomy" text NOT NULL,
	"placement" text NOT NULL,
	"config_digest" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cancellation_reason" text,
	"claimable_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"passes" jsonb,
	"refusals" jsonb,
	CONSTRAINT "run_owner_scoped_id" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" bigint NOT NULL,
	"protocol_version" integer NOT NULL,
	"worker_build_version" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "worker_owner_scoped_id" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "worker" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "worker_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" bigint NOT NULL,
	"worker_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "worker_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_code" ADD CONSTRAINT "enrollment_code_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_run_owner_scoped_fk" FOREIGN KEY ("owner_id","run_id") REFERENCES "public"."run"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_delivery" ADD CONSTRAINT "ingress_delivery_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation" ADD CONSTRAINT "installation_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_run_owner_scoped_fk" FOREIGN KEY ("owner_id","run_id") REFERENCES "public"."run"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_installation_owner_scoped_fk" FOREIGN KEY ("owner_id","installation_id") REFERENCES "public"."installation"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_repository_owner_scoped_fk" FOREIGN KEY ("owner_id","repository_id") REFERENCES "public"."repository"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker" ADD CONSTRAINT "worker_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_credential" ADD CONSTRAINT "worker_credential_owner_id_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_credential" ADD CONSTRAINT "worker_credential_worker_owner_scoped_fk" FOREIGN KEY ("owner_id","worker_id") REFERENCES "public"."worker"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrollment_code_owner_idx" ON "enrollment_code" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "finding_owner_idx" ON "finding" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "finding_bucket_idx" ON "finding" USING btree ("owner_id","bucket_key");--> statement-breakpoint
CREATE INDEX "ingress_delivery_owner_idx" ON "ingress_delivery" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "ingress_delivery_guid_idx" ON "ingress_delivery" USING btree ("delivery_guid");--> statement-breakpoint
CREATE INDEX "installation_owner_idx" ON "installation" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "publication_owner_idx" ON "publication" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "repository_owner_idx" ON "repository" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "run_owner_idx" ON "run" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_one_live_per_pull_request" ON "run" USING btree ("repository_id","pull_request_number") WHERE "run"."status" in ('queued', 'claimed', 'executing');--> statement-breakpoint
CREATE INDEX "worker_owner_idx" ON "worker" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "worker_credential_owner_idx" ON "worker_credential" USING btree ("owner_id");--> statement-breakpoint
CREATE POLICY "enrollment_code_tenant" ON "enrollment_code" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("enrollment_code"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("enrollment_code"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);--> statement-breakpoint
CREATE POLICY "finding_tenant" ON "finding" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("finding"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("finding"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);--> statement-breakpoint
CREATE POLICY "ingress_delivery_tenant" ON "ingress_delivery" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("ingress_delivery"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("ingress_delivery"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);--> statement-breakpoint
CREATE POLICY "installation_tenant" ON "installation" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("installation"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("installation"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);--> statement-breakpoint
CREATE POLICY "owner_tenant" ON "owner" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("owner"."id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("owner"."id" = nullif(current_setting('app.owner_id', true), '')::bigint);--> statement-breakpoint
CREATE POLICY "publication_tenant" ON "publication" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("publication"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("publication"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);--> statement-breakpoint
CREATE POLICY "repository_tenant" ON "repository" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("repository"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("repository"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);--> statement-breakpoint
CREATE POLICY "run_tenant" ON "run" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("run"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("run"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);--> statement-breakpoint
CREATE POLICY "worker_tenant" ON "worker" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("worker"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("worker"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);--> statement-breakpoint
CREATE POLICY "worker_credential_tenant" ON "worker_credential" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("worker_credential"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("worker_credential"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);