-- Back-fill пресета работ для компаний, зарегистрированных до появления
-- онбординга (миграция 0024 добавила таблицы, seed при регистрации
-- срабатывает только для новых юзеров). Идемпотентно: обрабатываем только
-- компании, у которых ещё нет ни одной работы.

WITH cats AS (
  SELECT code, id FROM work_categories WHERE company_id IS NULL
),
u AS (
  SELECT code, id FROM units
),
comps AS (
  SELECT c.id AS company_id
  FROM companies c
  WHERE c.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM work_items wi
      WHERE wi.company_id = c.id AND wi.deleted_at IS NULL
    )
),
presets(category_code, unit_code, name, ord) AS (VALUES
  ('install',       'pcs', 'Монтаж IP-камеры внутренней',           1),
  ('install',       'pcs', 'Монтаж IP-камеры уличной',              2),
  ('install',       'pcs', 'Монтаж датчика движения',               3),
  ('install',       'pcs', 'Монтаж считывателя СКУД',               4),
  ('install',       'pcs', 'Монтаж коммутатора / регистратора',     5),
  ('cabling',       'm',   'Прокладка кабеля UTP открытым способом', 6),
  ('cabling',       'm',   'Прокладка кабеля в кабель-канал',       7),
  ('cabling',       'm',   'Штробление в кирпиче / гипсокартоне',   8),
  ('cabling',       'm',   'Штробление в бетоне',                    9),
  ('commissioning', 'pcs', 'Пусконаладка системы видеонаблюдения',  10),
  ('commissioning', 'pcs', 'Настройка удалённого доступа',          11),
  ('other',         'pcs', 'Выезд специалиста',                     12),
  ('other',         'pcs', 'Демонтаж существующего оборудования',   13)
)
INSERT INTO work_items (company_id, source, category_id, unit_id, name, price, meta, is_active)
SELECT comps.company_id, 'company', cats.id, u.id, p.name, NULL, '{}'::jsonb, true
FROM comps
CROSS JOIN presets p
JOIN cats ON cats.code = p.category_code
JOIN u ON u.code = p.unit_code
ORDER BY comps.company_id, p.ord;
