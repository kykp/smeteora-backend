# Deploy — первый запуск и текущий процесс

Prod-инфраструктура:

- **VPS:** cloud.reg.ru, IP `194.67.103.33`.
- **Backend:** Node 22 в Docker (`ghcr.io/kykp/smeteora-backend`), слушает `127.0.0.1:3000`.
- **Postgres:** `postgres:16-alpine` в том же docker-compose, наружу не пробит.
- **Reverse proxy:** nginx на хосте, TLS через certbot, домен `api.smeteora.ru`.
- **Директория:** `/opt/smeteora-api/` (owner `smeteora`).
- **Данные БД:** `/opt/smeteora-api/pg_data/` (bind-mount).

Фронт живёт отдельно на `smeteora.ru` (тот же VPS, тот же nginx).

## Первый запуск

### 1. GitHub Actions Secrets

В `Settings → Secrets and variables → Actions`:

- `DEPLOY_HOST` = `194.67.103.33`
- `DEPLOY_USER` = `smeteora` (в группе `docker`, sudo не требуется)
- `DEPLOY_SSH_KEY_B64` = приватный ключ SSH в base64:
  ```
  ssh-keygen -t ed25519 -C "gha-deploy" -f ~/.ssh/smeteora-deploy -N ""
  base64 -w 0 < ~/.ssh/smeteora-deploy   # значение секрета
  cat ~/.ssh/smeteora-deploy.pub          # публичка → на сервер в authorized_keys
  ```

### 2. Настройка сервера

Под пользователем `smeteora` (не root):

```bash
# Публичный ключ GHA-деплоя.
mkdir -p ~/.ssh && chmod 700 ~/.ssh
# Добавить содержимое smeteora-deploy.pub → ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Директория деплоя.
sudo mkdir -p /opt/smeteora-api/pg_data
sudo chown -R smeteora:smeteora /opt/smeteora-api
cd /opt/smeteora-api

# Кладём docker-compose.prod.yml и docker/postgres-init.sh с этого репо.
# Один способ — склонировать репо и симлинкать нужные файлы:
git clone git@github.com:kykp/smeteora-backend.git repo
ln -s repo/docker-compose.prod.yml .
ln -s repo/docker docker

# Второй — просто скопировать эти два файла (без git):
# scp docker-compose.prod.yml docker/postgres-init.sh smeteora@194.67.103.33:/opt/smeteora-api/
```

### 3. Файлы окружения

`/opt/smeteora-api/.env` — по образцу `.env.production.example`. Реальные пароли/секреты:

```bash
# Генерация SESSION_SECRET:
openssl rand -hex 32
```

`/opt/smeteora-api/.env.postgres` — по образцу `.env.postgres.example`. Пароли ролей должны **совпадать** с теми что в `DATABASE_URL` / `DATABASE_URL_MIGRATOR` в `.env`.

Права:

```bash
chmod 600 /opt/smeteora-api/.env
chmod 600 /opt/smeteora-api/.env.postgres
```

### 4. Первый старт Postgres

```bash
cd /opt/smeteora-api
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml logs -f postgres
```

Ищем `Роли Smeteora созданы успешно.` в логах — значит `postgres-init.sh` отработал (только на пустом volume).

### 5. Первый прогон миграций

Образ ещё не в GHCR — либо ждём первый деплой (workflow сам применит миграции), либо собираем локально и пушим руками для инициализации:

```bash
# С локальной машины:
docker build -t ghcr.io/kykp/smeteora-backend:latest .
docker push ghcr.io/kykp/smeteora-backend:latest

# На сервере:
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrator
```

### 6. Запуск бэка

```bash
docker compose -f docker-compose.prod.yml up -d backend
curl http://127.0.0.1:3000/healthz
# {"status":"ok","uptime":0.5,"version":"0.0.1"}
```

### 7. nginx + TLS

```bash
sudo cp /opt/smeteora-api/docker/nginx-api.conf.example /etc/nginx/sites-available/api.smeteora.ru
sudo ln -s /etc/nginx/sites-available/api.smeteora.ru /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx -d api.smeteora.ru
```

certbot автопродление уже настроено через `certbot.timer` — новый домен подтянется.

### 8. Smoke test

```bash
curl -s https://api.smeteora.ru/healthz | jq .
# {"status":"ok","uptime": ..., "version": "..."}
```

## Обычный цикл деплоя

Push в `main` → CI (`ci.yml`) зелёный → срабатывает `deploy.yml`:

1. Собирает образ, пушит два тега: `sha-<12hex>` и `latest`.
2. По SSH: `docker compose pull` → `migrator` run --rm → `backend` up --force-recreate.
3. Smoke `/healthz` — 20 попыток за 60 секунд.

Даунтайм при обычном деплое — секунды на recreate backend-контейнера. Nginx делает 502 несколько секунд, потом отвечает.

## Откат

По sha на GHCR:

```bash
# На сервере:
docker pull ghcr.io/kykp/smeteora-backend:sha-<older>
docker tag ghcr.io/kykp/smeteora-backend:sha-<older> ghcr.io/kykp/smeteora-backend:latest
docker compose -f docker-compose.prod.yml up -d --force-recreate backend
```

Если сломала миграция — сложнее: миграции только forward. Смотри `CLAUDE.md` раздел про двухфазные разрушительные изменения.

## Диагностика

```bash
# Логи бэка (structured JSON).
docker compose -f docker-compose.prod.yml logs -f backend | jq .

# Логи Postgres.
docker compose -f docker-compose.prod.yml logs -f postgres

# Соединение с БД (под ролью migrator — для отладки).
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U smeteora_migrator -d smeteora

# nginx access/error логи.
sudo tail -f /var/log/nginx/api.smeteora.ru.access.log
sudo tail -f /var/log/nginx/api.smeteora.ru.error.log
```

## Ротация секретов

`SESSION_SECRET` меняется — все текущие сессии инвалидируются (пользователи логинятся заново). Норма для ротации: 1 раз в квартал.

Пароли ролей БД — сложнее, потому что нужно синхронно поменять и в `.env`, и в `.env.postgres`, и через `ALTER ROLE ... PASSWORD` в самой БД (init-скрипт срабатывает только на пустом volume).

```bash
docker compose exec postgres psql -U postgres -d smeteora \
  -c "ALTER ROLE smeteora_app WITH PASSWORD 'newpass';"
# Обновить .env → DATABASE_URL с новым паролем
docker compose up -d --force-recreate backend
```
