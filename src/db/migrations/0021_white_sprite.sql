ALTER TABLE "companies" ADD COLUMN "default_other_margin_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD COLUMN "custom_margin_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD COLUMN "expense_category" text;--> statement-breakpoint

-- Проставляем дефолтные наценки существующим компаниям, у которых они ещё
-- не заданы. Значения — средние по рынку слаботочки в РФ: 20/30/15%.
-- Юзер может изменить в настройках компании.
UPDATE "companies"
SET "default_equipment_margin_percent" = 20
WHERE "default_equipment_margin_percent" IS NULL;--> statement-breakpoint

UPDATE "companies"
SET "default_installation_margin_percent" = 30
WHERE "default_installation_margin_percent" IS NULL;--> statement-breakpoint

UPDATE "companies"
SET "default_other_margin_percent" = 15
WHERE "default_other_margin_percent" IS NULL;