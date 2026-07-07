CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"short_name" text NOT NULL,
	"full_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"source" text NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"source" text NOT NULL,
	"category_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"brand" text,
	"description" text,
	"buy_price" numeric(14, 4),
	"sell_price" numeric(14, 4),
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_product_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."product_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "units_code_unique" ON "units" USING btree ("code");--> statement-breakpoint
CREATE INDEX "product_categories_company_idx" ON "product_categories" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "product_categories_parent_idx" ON "product_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_company_code_unique" ON "product_categories" USING btree ("company_id","code") WHERE "product_categories"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "products_company_idx" ON "products" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "products_category_active_idx" ON "products" USING btree ("category_id","name") WHERE "products"."deleted_at" IS NULL AND "products"."is_active" = true;--> statement-breakpoint
CREATE INDEX "products_brand_idx" ON "products" USING btree ("brand") WHERE "products"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_sku_unique" ON "products" USING btree ("company_id","sku") WHERE "products"."deleted_at" IS NULL AND "products"."sku" IS NOT NULL;--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Полнотекстовый поиск по товарам: name + sku + brand.
-- Russian dict для стемминга. Комбо-колонка через выражение, чтобы не
-- держать generated column.
-- ──────────────────────────────────────────────────────────────

CREATE INDEX "products_search_idx" ON "products"
USING GIN (to_tsvector('russian',
  coalesce("name", '') || ' ' ||
  coalesce("sku", '') || ' ' ||
  coalesce("brand", '')
))
WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Триггеры updated_at.
-- ──────────────────────────────────────────────────────────────

CREATE TRIGGER units_set_updated_at
  BEFORE UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER product_categories_set_updated_at
  BEFORE UPDATE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Row-Level Security.
-- product_categories и products имеют nullable company_id для platform-контента.
-- Логика: читать видно свои + платформенные, писать/удалять — только свои.
-- units — глобальный справочник, вообще без RLS (всем видно, менять может
-- только smeteora_platform_editor через GRANT).
-- ──────────────────────────────────────────────────────────────

ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_categories_read ON product_categories
  FOR SELECT
  USING (
    company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint

CREATE POLICY product_categories_modify ON product_categories
  FOR ALL
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_read ON products
  FOR SELECT
  USING (
    company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    OR company_id IS NULL
  );
--> statement-breakpoint

CREATE POLICY products_modify ON products
  FOR ALL
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Права на роли.
-- units — read-only для app (нельзя ломать общий справочник).
-- product_categories и products — full для app (RLS ограничит своими).
-- platform_editor — full на все три (создаёт платформенный контент).
-- ──────────────────────────────────────────────────────────────

GRANT SELECT ON units TO smeteora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_categories TO smeteora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON products TO smeteora_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON units TO smeteora_platform_editor;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_categories TO smeteora_platform_editor;
GRANT SELECT, INSERT, UPDATE, DELETE ON products TO smeteora_platform_editor;
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Seed платформенных данных.
-- Единицы измерения и базовые категории. Стабильные code, чтобы фронт
-- мог мапиться. UUID генерируется автоматом.
-- ──────────────────────────────────────────────────────────────

INSERT INTO units (code, short_name, full_name, sort_order) VALUES
  ('pcs',   'шт',    'штука',              10),
  ('m',     'м',     'метр',               20),
  ('sqm',   'м²',    'квадратный метр',    30),
  ('set',   'к-т',   'комплект',           40),
  ('pack',  'упак',  'упаковка',           50),
  ('roll',  'рулон', 'рулон',              60),
  ('hour',  'час',   'час',                70),
  ('shift', 'смена', 'смена',              80);
--> statement-breakpoint

INSERT INTO product_categories (company_id, source, code, name, sort_order) VALUES
  (NULL, 'platform', 'video',    'Видеонаблюдение',        10),
  (NULL, 'platform', 'audio',    'Аудио и переговорные',   20),
  (NULL, 'platform', 'security', 'Охрана (СКУД, датчики)', 30),
  (NULL, 'platform', 'network',  'Сетевое оборудование',   40),
  (NULL, 'platform', 'cable',    'Кабели',                 50),
  (NULL, 'platform', 'power',    'Питание',                60),
  (NULL, 'platform', 'mount',    'Крепёж и монтаж',        70),
  (NULL, 'platform', 'other',    'Прочее',                 90);