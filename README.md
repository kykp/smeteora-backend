# Smeteora Backend

Fastify + TypeScript + PostgreSQL бэкенд для **Smeteora** — SPA-сметчика для строительных бригад.

Фронт: [smeteora](https://github.com/kykp/smeteora) (React 19 + Vite + FSD).

## Требования

- **Node.js** 22.x LTS
- **pnpm** 11.x (`corepack enable && corepack use pnpm@11`)
- **PostgreSQL** 16 (появится в следующем инкременте)

## Установка и запуск

```bash
pnpm install
cp .env.example .env

# Postgres 16 (dev на :5442, тест на :5433). Первый старт создаёт роли БД:
# smeteora_migrator, smeteora_app, smeteora_platform_editor.
pnpm db:up

# Применить миграции (использует роль smeteora_migrator).
pnpm db:migrate
pnpm db:migrate:test

# Запустить сервер.
pnpm dev
```

Проверка:

```bash
curl http://localhost:3000/healthz
# → {"status":"ok","uptime":1.234,"version":"0.0.1"}
```

Тесты (интеграционные, против реальной Postgres):

```bash
pnpm test
```

## Скрипты

| Скрипт                 | Что делает                              |
| ---------------------- | --------------------------------------- |
| `pnpm dev`             | Fastify через `tsx watch`               |
| `pnpm build`           | tsc сборка в `dist/`                    |
| `pnpm start`           | production запуск из `dist/`            |
| `pnpm lint`            | ESLint, ноль предупреждений             |
| `pnpm type-check`      | `tsc --noEmit`                          |
| `pnpm format`          | Prettier                                |
| `pnpm test`            | Vitest (интеграционные, реальная БД)    |
| `pnpm db:up`           | Postgres dev+test через docker compose  |
| `pnpm db:down`         | Остановить контейнеры Postgres          |
| `pnpm db:generate`     | Сгенерировать миграцию по Drizzle-схеме |
| `pnpm db:migrate`      | Применить миграции к dev БД             |
| `pnpm db:migrate:test` | То же для тестовой БД                   |

## Структура

```
smeteora-backend/
├── src/
│   ├── index.ts              bootstrap + graceful shutdown
│   ├── app.ts                фабрика Fastify (используется тестами)
│   ├── config.ts             zod-парсинг env
│   ├── plugins/              auth, cors, helmet, rate-limit, db, error-handler
│   ├── modules/<name>/       routes.ts, service.ts, repo.ts, schema.ts
│   ├── db/                   Drizzle schema, клиент, RLS helpers
│   └── routes/               системные (health)
├── migrations/               SQL миграции Drizzle Kit (forward-only)
└── packages/
    └── shared/               @smeteora/shared — ts-rest контракты + доменные типы
```

## Документация

Полный гайд по стеку, архитектуре, безопасности и правилам работы с кодом — в [`CLAUDE.md`](./CLAUDE.md).
Раздел «Мультитенантность и безопасность данных» обязателен к прочтению перед любым PR, добавляющим доменные эндпоинты.
