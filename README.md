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
pnpm dev
```

Проверка:

```bash
curl http://localhost:3000/healthz
# → {"status":"ok","uptime":1.234,"version":"0.0.1"}
```

## Скрипты

| Скрипт            | Что делает                            |
| ----------------- | ------------------------------------- |
| `pnpm dev`        | Fastify через `tsx watch`             |
| `pnpm build`      | tsc сборка в `dist/`                  |
| `pnpm start`      | production запуск из `dist/`          |
| `pnpm lint`       | ESLint, ноль предупреждений           |
| `pnpm type-check` | `tsc --noEmit`                        |
| `pnpm format`     | Prettier                              |
| `pnpm test`       | Vitest (интеграционные, реальная БД)  |

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
