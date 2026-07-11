ALTER TABLE "work_items" ADD COLUMN "trigger_category_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;

-- GIN-индекс для быстрого поиска работ по триггеру: при добавлении товара
-- в смету бэк ищет `WHERE trigger_category_ids @> ARRAY[categoryId]` — без
-- индекса это full-scan на work_items компании.
CREATE INDEX "work_items_trigger_categories_idx"
  ON "work_items"
  USING GIN ("trigger_category_ids")
  WHERE "deleted_at" IS NULL AND "is_active" = true;
