#!/bin/bash
# Инициализация сервисных ролей БД для Smeteora.
# Запускается один раз при первом старте контейнера (Postgres автоматически исполняет
# файлы из /docker-entrypoint-initdb.d в алфавитном порядке при пустом data-каталоге).
#
# Роли:
#   smeteora_migrator        — применяет миграции; SUPERUSER-подобные права (BYPASSRLS).
#                              В рантайме приложения НЕ используется. Credentials только в CI.
#   smeteora_app             — рантайм-роль приложения. БЕЗ BYPASSRLS.
#                              Все RLS-политики применяются к её запросам.
#   smeteora_platform_editor — для скриптов, создающих платформенные данные
#                              (общие товары, глобальные категории). BYPASSRLS.
#                              Credentials только у админ-скриптов, не в рантайме API.

set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE smeteora_migrator
    WITH LOGIN
         PASSWORD '${SMETEORA_MIGRATOR_PASSWORD}'
         CREATEDB
         BYPASSRLS;

  CREATE ROLE smeteora_app
    WITH LOGIN
         PASSWORD '${SMETEORA_APP_PASSWORD}';
  -- Никакого BYPASSRLS у app-роли: гарантия что баг в SQL не сможет обойти изоляцию.

  CREATE ROLE smeteora_platform_editor
    WITH LOGIN
         PASSWORD '${SMETEORA_PLATFORM_EDITOR_PASSWORD}'
         BYPASSRLS;

  -- Смена владельца БД на migrator: он создаёт схему, дальше выдаёт права app-роли.
  ALTER DATABASE ${POSTGRES_DB} OWNER TO smeteora_migrator;

  -- Даём app-роли базовые привилегии на public-схему. Права на конкретные таблицы
  -- migrator раздаёт из миграций (см. src/db/migrations/*.sql).
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO smeteora_app;
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO smeteora_platform_editor;
EOSQL
