ALTER TABLE "hr"."bonus_awards" ADD COLUMN "mistakes_applied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr"."bonus_awards" ADD COLUMN "mistake_deduction_poisha" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr"."bonus_awards" ADD COLUMN "mistake_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "hr"."bonus_awards" ADD CONSTRAINT "bonus_awards_mistakes" CHECK ("hr"."bonus_awards"."mistake_deduction_poisha" >= 0
        and ("hr"."bonus_awards"."mistakes_applied" or ("hr"."bonus_awards"."mistake_deduction_poisha" = 0 and cardinality("hr"."bonus_awards"."mistake_keys") = 0)));