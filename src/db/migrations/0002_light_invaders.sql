CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"address" text,
	"client_name" text,
	"client_phone" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"start_date" date,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_company_idx" ON "projects" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "projects_company_active_idx" ON "projects" USING btree ("company_id","created_at") WHERE "projects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "projects_company_status_idx" ON "projects" USING btree ("company_id","status") WHERE "projects"."deleted_at" IS NULL;
--> statement-breakpoint

-- Триггер обновления updated_at на каждый UPDATE.
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Row-Level Security. Второй эшелон изоляции: даже если приложение случайно
-- забудет WHERE company_id, Postgres под ролью smeteora_app всё равно не отдаст
-- чужие строки — политика projects_tenant_isolation отсекает всё что не совпадает
-- с current_setting('app.current_company_id').
--
-- current_setting(..., true) возвращает пустую строку когда переменная не установлена
-- (не NULL). Прямой cast ''::uuid бросает 22P02. NULLIF(..., '')::uuid → NULL,
-- предикат становится `company_id = NULL` → FALSE → RLS показывает 0 строк.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant_isolation ON projects
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

-- Права рантайм-роли и роли для платформенных скриптов.
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO smeteora_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO smeteora_platform_editor;