-- Инвариант: строка с product_id (то есть добавленная из каталога) должна
-- лежать в разделе, соответствующем kind:
--   kind='material' → «Оборудование»
--   kind='work'     → «Монтаж»
--
-- До этой миграции UI не проверял merge по разделу — при повторном добавлении
-- товара увеличивался quantity первой найденной строки того же product_id
-- независимо от её раздела. Плюс автолечение в ensureCanonicalSections
-- перекладывало все orphaned строки в «Другое» вслепую. В итоге у некоторых
-- юзеров товары «завалились» в «Другое» и остались там навсегда.
--
-- Идемпотентно: WHERE section_id <> target.id гарантирует no-op на уже
-- лежащих правильно строках. Строки с product_id IS NULL (ручные записи в
-- «Другом») не трогаем — они и должны там быть.

UPDATE estimate_line_items li
   SET section_id = target.id
  FROM estimate_sections target
 WHERE target.estimate_id = li.estimate_id
   AND target.title       = 'Оборудование'
   AND li.product_id      IS NOT NULL
   AND li.kind            = 'material'
   AND li.section_id     <> target.id;

UPDATE estimate_line_items li
   SET section_id = target.id
  FROM estimate_sections target
 WHERE target.estimate_id = li.estimate_id
   AND target.title       = 'Монтаж'
   AND li.product_id      IS NOT NULL
   AND li.kind            = 'work'
   AND li.section_id     <> target.id;
