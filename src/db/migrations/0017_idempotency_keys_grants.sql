-- Права рантайм-роли на новую таблицу idempotency_keys. В миграции 0016 её
-- создали, но GRANT'ы автоматически не выдаются — smeteora_app не могла даже
-- сделать SELECT, все мутационные эндпоинты падали в самом начале.
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO smeteora_app;
