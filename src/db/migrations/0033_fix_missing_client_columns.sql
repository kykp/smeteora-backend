-- Донакат колонок, которые предыдущие миграции объявили в journal, но
-- физически не создали ни на dev, ни на prod. Скорее всего разъезд появился
-- из-за восстановления БД из старого дампа при живом journal — hash
-- миграции есть, а ALTER TABLE не отработал. Из-за этого код запрашивал
-- отсутствующие колонки и роут отвечал 500.
--
-- IF NOT EXISTS делает миграцию идемпотентной: там где предыдущие миграции
-- отработали корректно, эта не изменит ничего.
--
-- Пропущенные колонки:
--   projects.client_inn / client_address — из 0014_rainy_veda
--   companies.pdf_offer_validity_days    — из 0015_uneven_tana_nile

ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_inn text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_address text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pdf_offer_validity_days integer;
