-- Проставляем стартовые цены и себестоимость типовым работам, засеянным
-- миграцией 0025 (тогда все price/cost были NULL). Обновляем только строки
-- source='company' с известным именем — чтобы не затронуть работы, которые
-- юзер уже переименовал. При совпадении имени НО price уже задан руками —
-- тоже пропускаем: юзер знает свои цифры лучше.

WITH presets(name, price, cost) AS (VALUES
  ('Монтаж IP-камеры внутренней',            2000::numeric, 1000::numeric),
  ('Монтаж IP-камеры уличной',               3000::numeric, 1500::numeric),
  ('Монтаж датчика движения',                1500::numeric,  700::numeric),
  ('Монтаж считывателя СКУД',                2500::numeric, 1200::numeric),
  ('Монтаж коммутатора / регистратора',      3000::numeric, 1500::numeric),
  ('Прокладка кабеля UTP открытым способом',  120::numeric,   60::numeric),
  ('Прокладка кабеля в кабель-канал',         180::numeric,   90::numeric),
  ('Штробление в кирпиче / гипсокартоне',     300::numeric,  150::numeric),
  ('Штробление в бетоне',                     500::numeric,  250::numeric),
  ('Пусконаладка системы видеонаблюдения',   5000::numeric, 2500::numeric),
  ('Настройка удалённого доступа',           2000::numeric, 1000::numeric),
  ('Выезд специалиста',                      1500::numeric,  800::numeric),
  ('Демонтаж существующего оборудования',    1000::numeric,  500::numeric)
)
UPDATE work_items wi
   SET price = p.price,
       cost  = p.cost
  FROM presets p
 WHERE wi.name       = p.name
   AND wi.source     = 'company'
   AND wi.price      IS NULL
   AND wi.deleted_at IS NULL;
