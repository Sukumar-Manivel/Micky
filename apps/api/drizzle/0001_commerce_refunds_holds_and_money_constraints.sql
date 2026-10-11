CREATE TYPE "public"."refund_status" AS ENUM('PENDING', 'PROCESSED', 'FAILED');--> statement-breakpoint
ALTER TYPE "public"."ledger_type" ADD VALUE 'SALE_REVERSAL' BEFORE 'PAYOUT_DEBIT';--> statement-breakpoint
ALTER TYPE "public"."ledger_type" ADD VALUE 'SALE_REINSTATEMENT' BEFORE 'PAYOUT_DEBIT';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'EXPIRED';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'REFUND_PENDING';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'REFUNDED';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'REFUND_FAILED';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'DISPUTED';--> statement-breakpoint
CREATE TABLE "payout_detail_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"old_upi_id" text,
	"new_upi_id" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "refund_status" DEFAULT 'PENDING' NOT NULL,
	"provider_refund_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "refunds_provider_payment_id_unique" UNIQUE("provider_payment_id"),
	CONSTRAINT "refunds_provider_refund_id_unique" UNIQUE("provider_refund_id"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount" > 0),
	CONSTRAINT "refunds_attempts_non_negative" CHECK ("refunds"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '30 minutes' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "disputed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uploader_profiles" ADD COLUMN "upi_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "payout_detail_changes" ADD CONSTRAINT "payout_detail_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_detail_changes_user_created_idx" ON "payout_detail_changes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_status_created_idx" ON "refunds" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_uploader_available_idx" ON "ledger_entries" USING btree ("uploader_id","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_type_per_order_idx" ON "ledger_entries" USING btree ("order_id","type") WHERE "ledger_entries"."order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_type_per_payout_idx" ON "ledger_entries" USING btree ("payout_id","type") WHERE "ledger_entries"."payout_id" is not null;--> statement-breakpoint
CREATE INDEX "orders_status_expires_idx" ON "orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_one_paid_exclusive_per_media_idx" ON "orders" USING btree ("media_id") WHERE "orders"."status" = 'PAID' and "orders"."license_type" = 'EXCLUSIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "orders_one_paid_per_buyer_media_idx" ON "orders" USING btree ("buyer_id","media_id") WHERE "orders"."status" = 'PAID';--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_payload_hash_unique" UNIQUE("payload_hash");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_amount_non_zero" CHECK ("ledger_entries"."amount" <> 0);--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_amount_sign_matches_type" CHECK (("ledger_entries"."type"::text in ('SALE_CREDIT', 'SALE_REINSTATEMENT', 'PAYOUT_REVERSAL') and "ledger_entries"."amount" > 0)
        or ("ledger_entries"."type"::text in ('SALE_REVERSAL', 'PAYOUT_DEBIT') and "ledger_entries"."amount" < 0)
        or "ledger_entries"."type"::text = 'ADJUSTMENT');--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_references_match_type" CHECK (("ledger_entries"."type"::text not in ('SALE_CREDIT', 'SALE_REVERSAL', 'SALE_REINSTATEMENT') or "ledger_entries"."order_id" is not null)
        and ("ledger_entries"."type"::text not in ('PAYOUT_DEBIT', 'PAYOUT_REVERSAL') or "ledger_entries"."payout_id" is not null));--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_adjustment_has_note" CHECK ("ledger_entries"."type"::text <> 'ADJUSTMENT' or length(trim(coalesce("ledger_entries"."note", ''))) >= 3);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_amount_positive" CHECK ("orders"."amount" > 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_split_valid" CHECK ("orders"."platform_fee" >= 0 and "orders"."uploader_share" >= 0 and "orders"."platform_fee" + "orders"."uploader_share" = "orders"."amount");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_inr" CHECK ("orders"."currency" = 'INR');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_download_count_non_negative" CHECK ("orders"."download_count" >= 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_captured_has_payment" CHECK ("orders"."status"::text not in ('PAID', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED', 'DISPUTED') or "orders"."provider_payment_id" is not null);--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_positive" CHECK ("payouts"."amount" > 0);--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): the ledger is append-only.
-- UPDATE and DELETE are refused unless a migration or an operator deliberately opens a
-- maintenance window for the current transaction with
--   SET LOCAL micky.ledger_maintenance = 'on';
-- TRUNCATE (test resets) is not affected. Corrections in normal operation are new
-- ADJUSTMENT rows, written through POST /admin/ledger-adjustments.
CREATE OR REPLACE FUNCTION "ledger_entries_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('micky.ledger_maintenance', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed; write an ADJUSTMENT instead', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_append_only"();
