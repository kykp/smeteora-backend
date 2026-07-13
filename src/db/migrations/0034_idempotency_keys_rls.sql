-- Изоляция idempotency_keys по тенанту.
--
-- Раньше PK был только на key (UUID). WHERE key=? в lib/idempotency.ts не
-- фильтровался по company_id/user_id — если два тенанта прислали один и тот
-- же uuid, второй получил бы cached responseBody первого (cross-tenant leak).
-- Плюс таблица не была под RLS, второго рубежа защиты не было.
--
-- Меняем:
--   1. PK → (company_id, user_id, key) — теперь один и тот же uuid можно
--      использовать в разных компаниях; коллизия внутри тенанта по-прежнему
--      блокируется на INSERT.
--   2. ENABLE ROW LEVEL SECURITY + tenant policy — второй эшелон против
--      случайного бага в WHERE.
--   3. GRANT для smeteora_app.
--
-- FK на companies/users не добавляем — таблица короткоживущая (TTL 24 часа),
-- orphan-строки не критичны, а FK удорожает вставку.

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
--> statement-breakpoint

ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_pkey
  PRIMARY KEY (company_id, user_id, key);
--> statement-breakpoint

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY idempotency_keys_tenant_isolation ON idempotency_keys
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO smeteora_app;
