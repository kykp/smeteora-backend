CREATE TABLE "estimate_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"section_id" uuid,
	"product_id" uuid,
	"catalog_snapshot" jsonb,
	"kind" text DEFAULT 'work' NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"price" numeric(14, 4) NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"vat_rate_override" numeric(5, 2),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" text,
	"title" text NOT NULL,
	"currency" char(3) DEFAULT 'RUB' NOT NULL,
	"vat_mode" text DEFAULT 'none' NOT NULL,
	"vat_rate" numeric(5, 2),
	"discount_percent" numeric(5, 2),
	"discount_amount" numeric(14, 2),
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_section_id_estimate_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."estimate_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_sections" ADD CONSTRAINT "estimate_sections_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_sections" ADD CONSTRAINT "estimate_sections_parent_id_estimate_sections_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."estimate_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_versions" ADD CONSTRAINT "estimate_versions_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_versions" ADD CONSTRAINT "estimate_versions_created_by_memberships_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_memberships_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "estimate_items_estimate_idx" ON "estimate_line_items" USING btree ("estimate_id","section_id","sort_order");--> statement-breakpoint
CREATE INDEX "estimate_items_company_idx" ON "estimate_line_items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "estimate_items_product_idx" ON "estimate_line_items" USING btree ("product_id") WHERE "estimate_line_items"."product_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "estimate_sections_estimate_idx" ON "estimate_sections" USING btree ("estimate_id","sort_order");--> statement-breakpoint
CREATE INDEX "estimate_sections_parent_idx" ON "estimate_sections" USING btree ("estimate_id","parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "estimate_sections_company_idx" ON "estimate_sections" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "estimate_versions_estimate_number_idx" ON "estimate_versions" USING btree ("estimate_id","version_number");--> statement-breakpoint
CREATE INDEX "estimate_versions_company_idx" ON "estimate_versions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "estimates_company_idx" ON "estimates" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "estimates_project_active_idx" ON "estimates" USING btree ("company_id","project_id","created_at") WHERE "estimates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "estimates_company_status_idx" ON "estimates" USING btree ("company_id","status") WHERE "estimates"."deleted_at" IS NULL;
--> statement-breakpoint

-- Триггеры updated_at на каждой таблице с этой колонкой.
CREATE TRIGGER estimates_set_updated_at
  BEFORE UPDATE ON estimates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER estimate_sections_set_updated_at
  BEFORE UPDATE ON estimate_sections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER estimate_line_items_set_updated_at
  BEFORE UPDATE ON estimate_line_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Row-Level Security для всей ветки estimates.
-- company_id денормализован во все три "детских" таблицы (sections, line_items,
-- versions) чтобы политика не делала JOIN на estimates для каждой строки.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimates_tenant_isolation ON estimates
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE estimate_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimate_sections_tenant_isolation ON estimate_sections
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE estimate_line_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimate_line_items_tenant_isolation ON estimate_line_items
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE estimate_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY estimate_versions_tenant_isolation ON estimate_versions
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- Права рантайм-роли и роли платформенного редактора.
GRANT SELECT, INSERT, UPDATE, DELETE ON estimates TO smeteora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON estimate_sections TO smeteora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON estimate_line_items TO smeteora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON estimate_versions TO smeteora_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON estimates TO smeteora_platform_editor;
GRANT SELECT, INSERT, UPDATE, DELETE ON estimate_sections TO smeteora_platform_editor;
GRANT SELECT, INSERT, UPDATE, DELETE ON estimate_line_items TO smeteora_platform_editor;
GRANT SELECT, INSERT, UPDATE, DELETE ON estimate_versions TO smeteora_platform_editor;