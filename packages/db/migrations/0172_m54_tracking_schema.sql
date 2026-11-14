CREATE SCHEMA "tracking";
--> statement-breakpoint
CREATE TABLE "tracking"."deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_row_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "deliveries_destination" CHECK ("tracking"."deliveries"."destination" in ('meta', 'ga4', 'tiktok', 'google_ads')),
	CONSTRAINT "deliveries_status" CHECK ("tracking"."deliveries"."status" in ('waiting', 'queued', 'sent', 'failed', 'skipped')),
	CONSTRAINT "deliveries_attempts" CHECK ("tracking"."deliveries"."attempts" >= 0),
	CONSTRAINT "deliveries_sent_at" CHECK (("tracking"."deliveries"."status" = 'sent') = ("tracking"."deliveries"."sent_at" is not null)),
	CONSTRAINT "deliveries_response_bounded" CHECK (pg_column_size("tracking"."deliveries"."response") < 4096)
);
--> statement-breakpoint
CREATE TABLE "tracking"."destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"client_enabled" boolean DEFAULT false NOT NULL,
	"public_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_sealed" "bytea",
	"secret_fingerprint" text,
	"key_id" text,
	"test_code" text DEFAULT '' NOT NULL,
	"api_version" text DEFAULT '' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_status" text,
	"last_test_error" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destinations_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "destinations_kind" CHECK ("tracking"."destinations"."kind" in ('meta', 'ga4', 'tiktok', 'google_ads')),
	CONSTRAINT "destinations_secret_complete" CHECK (("tracking"."destinations"."secret_sealed" is null) = ("tracking"."destinations"."secret_fingerprint" is null)
          and ("tracking"."destinations"."secret_sealed" is null) = ("tracking"."destinations"."key_id" is null)),
	CONSTRAINT "destinations_test_code" CHECK ("tracking"."destinations"."test_code" ~ '^[A-Za-z0-9_-]{0,64}$'),
	CONSTRAINT "destinations_api_version" CHECK ("tracking"."destinations"."api_version" ~ '^(v[0-9]{1,3}([.][0-9]{1,2})?)?$'),
	CONSTRAINT "destinations_last_test_status" CHECK ("tracking"."destinations"."last_test_status" is null or "tracking"."destinations"."last_test_status" in ('ok', 'failed')),
	CONSTRAINT "destinations_sections_bounded" CHECK (pg_column_size("tracking"."destinations"."public_ids") + pg_column_size("tracking"."destinations"."options") < 8192)
);
--> statement-breakpoint
CREATE TABLE "tracking"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"event_id" text NOT NULL,
	"event_name" text NOT NULL,
	"stage" text,
	"order_id" uuid,
	"value_poisha" bigint,
	"currency" text,
	"action_source" text,
	"user_masked" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"match_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload_sealed" "bytea",
	"key_id" text,
	"event_time" timestamp with time zone NOT NULL,
	"test_mode" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "events_kind" CHECK ("tracking"."events"."kind" in ('stage', 'refund', 'browser', 'test')),
	CONSTRAINT "events_event_id_shape" CHECK ("tracking"."events"."event_id" ~ '^[!-~]{1,100}$'),
	CONSTRAINT "events_event_name_shape" CHECK ("tracking"."events"."event_name" ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
	CONSTRAINT "events_stage" CHECK ("tracking"."events"."stage" is null
          or "tracking"."events"."stage" in ('placed', 'confirmed', 'delivered', 'returned', 'cancelled')),
	CONSTRAINT "events_stage_kind" CHECK (("tracking"."events"."kind" in ('stage', 'refund')) = ("tracking"."events"."stage" is not null)
          and ("tracking"."events"."kind" in ('stage', 'refund')) = ("tracking"."events"."order_id" is not null)),
	CONSTRAINT "events_value" CHECK ("tracking"."events"."value_poisha" is null or "tracking"."events"."value_poisha" >= 0),
	CONSTRAINT "events_currency" CHECK ("tracking"."events"."currency" is null or "tracking"."events"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "events_sealed" CHECK (("tracking"."events"."payload_sealed" is null) or ("tracking"."events"."key_id" is not null)),
	CONSTRAINT "events_bounded" CHECK (pg_column_size("tracking"."events"."custom_data") + pg_column_size("tracking"."events"."user_masked")
          + pg_column_size("tracking"."events"."match_keys") < 32768)
);
--> statement-breakpoint
CREATE TABLE "tracking"."settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"purchase_stage" text DEFAULT 'confirmed' NOT NULL,
	"stage_routes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"web_routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proxy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"test_mode" boolean DEFAULT false NOT NULL,
	"send_name_and_city" boolean DEFAULT false NOT NULL,
	"chat_to_ga4" boolean DEFAULT false NOT NULL,
	"default_country_code" text DEFAULT '880' NOT NULL,
	"log_retention_days" integer DEFAULT 30 NOT NULL,
	"imported_from" text,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_settings_purchase_stage" CHECK ("tracking"."settings"."purchase_stage" in ('placed', 'confirmed', 'delivered')),
	CONSTRAINT "tracking_settings_country_code" CHECK ("tracking"."settings"."default_country_code" ~ '^[0-9]{1,4}$'),
	CONSTRAINT "tracking_settings_retention" CHECK ("tracking"."settings"."log_retention_days" between 1 and 365),
	CONSTRAINT "tracking_settings_imported_from" CHECK ("tracking"."settings"."imported_from" is null
          or "tracking"."settings"."imported_from" in ('storefront', 'marketing', 'storefront_and_marketing', 'none')),
	CONSTRAINT "tracking_settings_sections_bounded" CHECK (pg_column_size("tracking"."settings"."stage_routes") + pg_column_size("tracking"."settings"."web_routes")
          + pg_column_size("tracking"."settings"."proxy") < 16384)
);
--> statement-breakpoint
CREATE TABLE "tracking"."order_signals" (
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"signals_sealed" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"present" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_signals_pkey" PRIMARY KEY("org_id","order_id"),
	CONSTRAINT "order_signals_present_bounded" CHECK (pg_column_size("tracking"."order_signals"."present") < 2048)
);
--> statement-breakpoint
ALTER TABLE "tracking"."deliveries" ADD CONSTRAINT "deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking"."deliveries" ADD CONSTRAINT "deliveries_org_id_event_row_id_fk" FOREIGN KEY ("org_id","event_row_id") REFERENCES "tracking"."events"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking"."destinations" ADD CONSTRAINT "destinations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking"."events" ADD CONSTRAINT "events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking"."events" ADD CONSTRAINT "events_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking"."settings" ADD CONSTRAINT "settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking"."order_signals" ADD CONSTRAINT "order_signals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking"."order_signals" ADD CONSTRAINT "order_signals_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_org_event_destination_idx" ON "tracking"."deliveries" USING btree ("org_id","event_row_id","destination");--> statement-breakpoint
CREATE INDEX "deliveries_org_idx" ON "tracking"."deliveries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "deliveries_org_status_idx" ON "tracking"."deliveries" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "destinations_org_kind_idx" ON "tracking"."destinations" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "destinations_org_idx" ON "tracking"."destinations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "events_org_idx" ON "tracking"."events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "events_org_created_idx" ON "tracking"."events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "events_org_order_idx" ON "tracking"."events" USING btree ("org_id","order_id");--> statement-breakpoint
CREATE INDEX "events_expires_idx" ON "tracking"."events" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_org_server_event_idx" ON "tracking"."events" USING btree ("org_id","event_id") WHERE "tracking"."events"."kind" <> 'browser';--> statement-breakpoint
CREATE INDEX "tracking_settings_org_idx" ON "tracking"."settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "order_signals_org_idx" ON "tracking"."order_signals" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "order_signals_expires_idx" ON "tracking"."order_signals" USING btree ("expires_at");