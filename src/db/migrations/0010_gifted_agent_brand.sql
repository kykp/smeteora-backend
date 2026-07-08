CREATE TABLE "price_list_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"original_filename" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_created" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "price_list_uploads" ADD CONSTRAINT "price_list_uploads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_uploads" ADD CONSTRAINT "price_list_uploads_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_list_uploads_company_idx" ON "price_list_uploads" USING btree ("company_id","created_at") WHERE "price_list_uploads"."status" <> 'discarded';--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Триггер updated_at.
-- ──────────────────────────────────────────────────────────────

CREATE TRIGGER price_list_uploads_set_updated_at
  BEFORE UPDATE ON price_list_uploads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Row-Level Security. Загрузки видны только своей компании — платформенных
-- прайс-листов не бывает, это всегда данные конкретного тенанта.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE price_list_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY price_list_uploads_tenant_isolation ON price_list_uploads
  FOR ALL
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON price_list_uploads TO smeteora_app;