CREATE TYPE "public"."category" AS ENUM('FIRE', 'ACCIDENT', 'FLOOD', 'WEATHER', 'PROTEST', 'CRIME', 'INFRASTRUCTURE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."ledger_type" AS ENUM('SALE_CREDIT', 'PAYOUT_DEBIT', 'PAYOUT_REVERSAL', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."license_type" AS ENUM('NON_EXCLUSIVE', 'EXCLUSIVE');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('PROCESSING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'FAILED', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('VIDEO', 'PHOTO');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('CREATED', 'PAID', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('REQUESTED', 'PAID', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('OPEN', 'RESOLVED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('UPLOADER', 'CHANNEL', 'ADMIN');--> statement-breakpoint
CREATE TABLE "channel_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"organization" text NOT NULL,
	"website" text,
	"status" "channel_status" DEFAULT 'PENDING' NOT NULL,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"category" "category" NOT NULL,
	"geohash" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"location_name" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"media_count" integer DEFAULT 0 NOT NULL,
	"uploader_count" integer DEFAULT 0 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"trend_score" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"type" "ledger_type" NOT NULL,
	"amount" integer NOT NULL,
	"order_id" uuid,
	"payout_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"incident_id" uuid,
	"type" "media_type" NOT NULL,
	"status" "media_status" DEFAULT 'PROCESSING' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" "category" NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"geohash" text NOT NULL,
	"location_name" text,
	"captured_at" timestamp with time zone NOT NULL,
	"original_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"duration_sec" double precision,
	"width" integer,
	"height" integer,
	"preview_key" text,
	"thumb_key" text,
	"hls_key_hex" text,
	"price_non_exclusive" integer NOT NULL,
	"price_exclusive" integer NOT NULL,
	"exclusive_sold" boolean DEFAULT false NOT NULL,
	"processing_error" text,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"license_type" "license_type" NOT NULL,
	"amount" integer NOT NULL,
	"platform_fee" integer NOT NULL,
	"uploader_share" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "order_status" DEFAULT 'CREATED' NOT NULL,
	"provider" text NOT NULL,
	"provider_order_id" text NOT NULL,
	"provider_payment_id" text,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "orders_provider_order_id_unique" UNIQUE("provider_order_id"),
	CONSTRAINT "orders_provider_payment_id_unique" UNIQUE("provider_payment_id")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"upi_id" text NOT NULL,
	"status" "payout_status" DEFAULT 'REQUESTED' NOT NULL,
	"reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid,
	"reporter_email" text NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"status" "report_status" DEFAULT 'OPEN' NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "uploader_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"upi_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"media_id" uuid PRIMARY KEY NOT NULL,
	"ai_score" double precision,
	"ai_model" text,
	"frames_scored" integer DEFAULT 0 NOT NULL,
	"c2pa_status" text NOT NULL,
	"c2pa_issuer" text,
	"metadata" jsonb NOT NULL,
	"phashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"duplicate_of_id" uuid,
	"signals" jsonb NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_profiles" ADD CONSTRAINT "channel_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploader_profiles" ADD CONSTRAINT "uploader_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_profiles_status_idx" ON "channel_profiles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "incidents_geohash_last_seen_idx" ON "incidents" USING btree ("geohash","last_seen_at");--> statement-breakpoint
CREATE INDEX "incidents_trend_idx" ON "incidents" USING btree ("trend_score");--> statement-breakpoint
CREATE INDEX "incidents_last_seen_idx" ON "incidents" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "ledger_uploader_created_idx" ON "ledger_entries" USING btree ("uploader_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_credit_per_order_idx" ON "ledger_entries" USING btree ("order_id") WHERE "ledger_entries"."type" = 'SALE_CREDIT';--> statement-breakpoint
CREATE INDEX "media_status_created_idx" ON "media" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "media_uploader_created_idx" ON "media" USING btree ("uploader_id","created_at");--> statement-breakpoint
CREATE INDEX "media_incident_idx" ON "media" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "media_geohash_idx" ON "media" USING btree ("geohash");--> statement-breakpoint
CREATE INDEX "media_checksum_idx" ON "media" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "orders_buyer_created_idx" ON "orders" USING btree ("buyer_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_media_idx" ON "orders" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "payouts_uploader_created_idx" ON "payouts" USING btree ("uploader_id","created_at");--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reports_status_created_idx" ON "reports" USING btree ("status","created_at");