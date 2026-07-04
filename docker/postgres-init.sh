#!/bin/bash
# Bootstrap ролей для prod-инстанса Postgres.
#
# docker-entrypoint.sh запускает всё из /docker-entrypoint-initdb.d/
# ровно один раз — на пустом volume. При повторных запусках контейнера
# (compose up после down) скрипт НЕ выполняется. Если нужно поменять
# пароли/роли, делать через psql руками.
#
# Пароли ролей приходят из env-переменных, заданных в .env.postgres:
#   SMETEORA_APP_PASSWORD
#   SMETEORA_MIGRATOR_PASSWORD
#   SMETEORA_PLATFORM_EDITOR_PASSWORD
#
# Если какая-то из переменных не задана — падаем с внятным сообщением,
# чтобы не создать роль с пустым паролем.

set -euo pipefail

for var in SMETEORA_APP_PASSWORD SMETEORA_MIGRATOR_PASSWORD SMETEORA_PLATFORM_EDITOR_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: environment variable $var не задана — не могу создать роли Postgres." >&2
    exit 1
  fi
done

# Роли:
#   smeteora_app             — рантайм-роль приложения. БЕЗ BYPASSRLS.
#   smeteora_migrator        — для db:migrate. С BYPASSRLS + CREATEDB.
#   smeteora_platform_editor — для скриптов создания платформенных данных. С BYPASSRLS.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE smeteora_app WITH LOGIN PASSWORD '$SMETEORA_APP_PASSWORD' NOBYPASSRLS;
  CREATE ROLE smeteora_migrator WITH LOGIN PASSWORD '$SMETEORA_MIGRATOR_PASSWORD' BYPASSRLS CREATEDB;
  CREATE ROLE smeteora_platform_editor WITH LOGIN PASSWORD '$SMETEORA_PLATFORM_EDITOR_PASSWORD' BYPASSRLS;

  GRANT CONNECT ON DATABASE $POSTGRES_DB TO smeteora_app;
  GRANT CONNECT ON DATABASE $POSTGRES_DB TO smeteora_migrator;
  GRANT CONNECT ON DATABASE $POSTGRES_DB TO smeteora_platform_editor;

  -- Мигратор создаёт таблицы, схемы (drizzle-мета) и меняет DDL под свои руки.
  -- Простой CREATEDB на роли позволяет только создавать НОВЫЕ базы; для CREATE SCHEMA
  -- в существующей нужно либо GRANT CREATE ON DATABASE, либо владение. Ownership
  -- проще: даёт полный DDL, включая расширения и триггеры без отдельных GRANT'ов.
  ALTER DATABASE $POSTGRES_DB OWNER TO smeteora_migrator;
EOSQL

echo "Роли Smeteora созданы успешно."
