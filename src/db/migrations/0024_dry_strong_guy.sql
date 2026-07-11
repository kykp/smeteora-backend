CREATE TABLE "work_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"source" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"source" text NOT NULL,
	"category_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" numeric(14, 4),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "work_categories" ADD CONSTRAINT "work_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_category_id_work_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."work_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_categories_company_idx" ON "work_categories" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_categories_company_code_unique" ON "work_categories" USING btree ("company_id","code") WHERE "work_categories"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "work_items_company_idx" ON "work_items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "work_items_category_active_idx" ON "work_items" USING btree ("category_id","name") WHERE "work_items"."deleted_at" IS NULL AND "work_items"."is_active" = true;--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Триггеры updated_at.
-- ──────────────────────────────────────────────────────────────

CREATE TRIGGER work_categories_set_updated_at
  BEFORE UPDATE ON work_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER work_items_set_updated_at
  BEFORE UPDATE ON work_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Row-Level Security.
-- Аналогично product_categories/products: читать видно свои + платформенные,
-- писать/удалять — только свои. Nullable company_id для platform-контента.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE work_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY work_categories_read ON work_categories
  FOR SELECT
  USING (
    company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint

CREATE POLICY work_categories_modify ON work_categories
  FOR ALL
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY work_items_read ON work_items
  FOR SELECT
  USING (
    company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint

CREATE POLICY work_items_modify ON work_items
  FOR ALL
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Права на роли.
-- ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON work_categories TO smeteora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_items TO smeteora_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON work_categories TO smeteora_platform_editor;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_items TO smeteora_platform_editor;
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Seed платформенных категорий работ. Плоский набор из 4 категорий —
-- покрывает базовые сценарии низковольтника: прокладка, установка,
-- пусконаладка, прочее (выезд, демонтаж, диагностика).
-- ──────────────────────────────────────────────────────────────

INSERT INTO work_categories (company_id, source, code, name, sort_order) VALUES
  (NULL, 'platform', 'cabling',       'Прокладка кабеля',      10),
  (NULL, 'platform', 'install',       'Установка оборудования', 20),
  (NULL, 'platform', 'commissioning', 'Пусконаладка',          30),
  (NULL, 'platform', 'other',         'Прочее',                90);