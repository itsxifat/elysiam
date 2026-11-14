CREATE SCHEMA "staff_activity";
--> statement-breakpoint
CREATE TABLE "staff_activity"."settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"call_back_grace_minutes" integer DEFAULT 30 NOT NULL,
	"first_reply_minutes" integer DEFAULT 15 NOT NULL,
	"unanswered_minutes" integer DEFAULT 60 NOT NULL,
	"wrap_up_minutes" integer DEFAULT 10 NOT NULL,
	"workday_start_minute" integer DEFAULT 540 NOT NULL,
	"workday_end_minute" integer DEFAULT 1320 NOT NULL,
	"require_verification_call" boolean DEFAULT true NOT NULL,
	"show_colleague_names" boolean DEFAULT true NOT NULL,
	"mistakes_reduce_bonuses" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_minutes" CHECK ("staff_activity"."settings"."call_back_grace_minutes" between 1 and 1440
        and "staff_activity"."settings"."first_reply_minutes" between 1 and 1440
        and "staff_activity"."settings"."unanswered_minutes" between 1 and 1440
        and "staff_activity"."settings"."wrap_up_minutes" between 1 and 1440),
	CONSTRAINT "settings_workday" CHECK ("staff_activity"."settings"."workday_start_minute" between 0 and 1439
        and "staff_activity"."settings"."workday_end_minute" between 1 and 1440
        and "staff_activity"."settings"."workday_start_minute" < "staff_activity"."settings"."workday_end_minute")
);
--> statement-breakpoint
CREATE TABLE "staff_activity"."mistake_reviews" (
	"org_id" uuid NOT NULL,
	"mistake_key" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mistake_reviews_pkey" PRIMARY KEY("org_id","mistake_key"),
	CONSTRAINT "mistake_reviews_status" CHECK ("staff_activity"."mistake_reviews"."status" in ('confirmed', 'dismissed')),
	CONSTRAINT "mistake_reviews_note" CHECK ("staff_activity"."mistake_reviews"."note" is null or char_length("staff_activity"."mistake_reviews"."note") <= 500),
	CONSTRAINT "mistake_reviews_key" CHECK (char_length("staff_activity"."mistake_reviews"."mistake_key") between 3 and 200)
);
--> statement-breakpoint
CREATE TABLE "team"."presence_spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text NOT NULL,
	"paused" boolean NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presence_spans_state" CHECK ("team"."presence_spans"."state" in ('active', 'idle')),
	CONSTRAINT "presence_spans_order" CHECK ("team"."presence_spans"."ended_at" >= "team"."presence_spans"."started_at")
);
--> statement-breakpoint
ALTER TABLE "staff_activity"."settings" ADD CONSTRAINT "settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_activity"."mistake_reviews" ADD CONSTRAINT "mistake_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_activity"."mistake_reviews" ADD CONSTRAINT "mistake_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team"."presence_spans" ADD CONSTRAINT "presence_spans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team"."presence_spans" ADD CONSTRAINT "presence_spans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mistake_reviews_org_idx" ON "staff_activity"."mistake_reviews" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mistake_reviews_org_user_idx" ON "staff_activity"."mistake_reviews" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "presence_spans_org_idx" ON "team"."presence_spans" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "presence_spans_org_user_started_idx" ON "team"."presence_spans" USING btree ("org_id","user_id","started_at");--> statement-breakpoint
CREATE INDEX "presence_spans_org_started_idx" ON "team"."presence_spans" USING btree ("org_id","started_at");