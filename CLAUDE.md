# CLAUDE.md

Гайд для агентов и разработчиков бэкенда **Smeteora**.
Фронт — отдельный репозиторий (React 19 + Vite + FSD), его `CLAUDE.md` описывает клиентские правила. Стилистика, тон общения на русском, отношение к комментариям и коммитам — общие. Всё что касается доменных типов и API-контрактов — живёт в пакете `@smeteora/shared` и разделяется через workspace / GitHub Packages.

## Стек

- **Node.js 22 LTS**, **pnpm 11**, **TypeScript strict** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, никакого `any`).
- **Fastify 5** + **fastify-type-provider-zod** — HTTP-фреймворк с zod-валидацией.
- **Zod 3** — валидация всех входов и всех ответов.
- **PostgreSQL 16** + **Drizzle ORM** — schema-first, миграции только forward.
- **ts-rest** — контракт-first REST. Контракт живёт в `@smeteora/shared`, фронт получает автоматически типизированный SDK.
- **argon2** (пакет `argon2`) — хеширование паролей (argon2id).
- **Плагины Fastify:** `@fastify/helmet`, `@fastify/cors`, `@fastify/cookie`, `@fastify/rate-limit`.
- **Логгер** — встроенный **Pino** с redact-конфигом для секретов.
- **Тесты** — **Vitest**, интеграционные, против **реальной Postgres**. Никаких моков БД.
- **Линт:** ESLint 9 flat config + Prettier + Husky + lint-staged + commitlint (Conventional Commits).

Совпадение с фронтом сознательное: коммиты, комментарии, авторство, tooling — те же.

---

## Мультитенантность и безопасность данных

**Это стержень системы. Не «фича на потом» — фундамент, влияющий на каждую таблицу и каждый запрос с первой миграции.**

Требование продукта:

> Данные одной компании **никогда** не должны быть доступны другой компании — ни через кривой запрос, ни через IDOR, ни через баг в фильтре, ни через админский эндпоинт.

Реализация — **defense in depth**: несколько независимых слоёв защиты, каждый закрывает свой класс ошибок.

### Модель тенантов

Три сущности определяют, кто и на что имеет право:

```
users              учётка человека (email + password_hash), НЕ привязана к компании
companies          тенант (клиент продукта), root-сущность
memberships        связь N-к-N: юзер ↔ компания + роль
```

**Единственный источник правды о принадлежности к компании — `memberships`.** У `users` **нет** поля `company_id`. Иначе получим два источника, которые разъедутся.

- Один человек может состоять в нескольких компаниях (сотрудник компании А + консультант в компании Б).
- Session хранит `active_membership_id` — с какой компании юзер сейчас работает. Переключение — через `POST /api/v1/auth/switch-company`, а не через отдельный логин.
- Уволенный сотрудник → `UPDATE memberships SET status='disabled'`. Его учётка и логины остаются, но по этой компании доступа больше нет. Данные компании нетронуты.

Все доменные таблицы (`projects`, `estimates`, `expenses`, `products`, любое что появится дальше) **обязаны** иметь `company_id UUID NOT NULL REFERENCES companies(id)` + индекс на `company_id` + partial index с `WHERE deleted_at IS NULL` для активных строк.

### Четыре гейта доступа

На каждом защищённом эндпоинте запрос проходит четыре проверки. Любая не прошла — дальше не пускаем.

**Гейт 1. Session valid.**
Из cookie достаём `session_id`. В таблице `sessions` строка: `revoked_at IS NULL`, `expires_at > now()`. Иначе — `401`.

**Гейт 2. Membership active.**
Session хранит `active_membership_id`. JOIN на `memberships` → `status='active'`, компания не удалена. Из этого шага получаем `{ companyId, role }`. Иначе — `401`. Именно этот гейт делает уволенных сотрудников бессильными без похода в `sessions`.

**Гейт 3. Role check.**
На каждом эндпоинте декларативно указана минимальная роль:

```ts
app.get('/api/v1/projects', { preHandler: requireRole('viewer') }, handler);
app.post('/api/v1/projects', { preHandler: requireRole('member') }, handler);
app.delete('/api/v1/projects/:id', { preHandler: requireRole('admin') }, handler);
app.post('/api/v1/company/billing', { preHandler: requireRole('owner') }, handler);
```

Иерархия: `owner > admin > member > viewer`. `requireRole('member')` пропускает member/admin/owner, отсекает viewer → `403`.
**Ни один хендлер не проверяет роль вручную.** Только через декларативный preHandler — иначе кто-то забудет.

**Гейт 4. Company scope (repo + RLS).**
Каждый доменный запрос идёт в транзакции с `SET LOCAL app.current_company_id`. Postgres через RLS отсекает чужие строки. Repository-слой поверх дополнительно инжектит `WHERE company_id = ?`. Два независимых механизма, страхуют друг друга.

**Публичные эндпоинты** (`/healthz`, `/api/v1/auth/register`, `/api/v1/auth/login`) отмечены явно как public. **PR, добавляющий доменный эндпоинт без `requireRole(...)`, не мержится.**

### RLS и транзакция на каждый запрос

Каждый запрос к доменным таблицам обёрнут в транзакцию, в которой первым делом выставляется контекст компании. Реализация — `runInCompanyContext(db, companyId, fn)` в `src/plugins/with-company-context.ts`:

```ts
await runInCompanyContext(app.db, ctx.companyId, async (tx) => {
  // все дальнейшие запросы в этой транзакции автоматически фильтруются RLS
  return projectRepo.list(tx);
});
```

Под капотом: `db.transaction` + `SELECT set_config('app.current_company_id', $1, true)` — параметр `is_local=true` эквивалентен `SET LOCAL`, действует до конца транзакции. `current_setting('app.current_company_id', true)` в RLS-политиках возвращает **пустую строку** если контекст не установлен (не NULL!), поэтому политики используют `NULLIF(..., '')::uuid` — без этого cast `''::uuid` падает с `22P02`.

Механика реализована как Fastify-плагин `withCompanyContext`, вешается на `preHandler` защищённых роутов. Хендлер получает `request.tx` и работает через него.

Пример RLS-политики (создаётся в миграции для каждой доменной таблицы):

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_tenant_isolation ON projects
  USING (company_id = current_setting('app.current_company_id', true)::uuid);
```

**Правила:**

- **Все доменные запросы** — через `request.tx`, **никогда** через голый `db`.
- **Долгие операции** (генерация PDF, отправка email, вызов внешнего API) — **не внутри** доменной транзакции. Транзакция закрывается быстро, побочные эффекты — вне.
- **Роли в БД:**
  - `smeteora_app` — рантайм-роль без `BYPASSRLS`. С ней приложение физически не может обойти изоляцию.
  - `smeteora_migrator` — с `BYPASSRLS`. Credentials только у CI/deploy-пайплайна, в рантайме недоступны.
  - `smeteora_platform_editor` — для скриптов, создающих платформенные данные (наши товары, глобальные категории). Credentials только у админ-скриптов.
- **Nullable `company_id` для расширяемости.** Если таблица должна содержать и «наши» строки (например, `products` — платформенный каталог виден всем), `company_id` делаем nullable, а RLS-политика читает `company_id = current OR company_id IS NULL`. См. секцию про каталог.

### Идентификаторы

- **Все первичные ключи — UUID v4** через `gen_random_uuid()` (встроен в Postgres 16, extension не нужна).
- Никаких serial int'ов: иначе через баг в проверке доступа можно перебрать `/projects/1`, `/projects/2` и увидеть чужие данные.
- В URL — UUID. Наружу `company_id` не отдаётся никогда — клиент не должен догадываться о существовании чужих компаний.

### Sessions

Сессия — самодостаточная строка в Postgres. Никакого JWT, никакого Redis на старте.

```
sessions
  id                     uuid pk                    session_id, лежит в cookie
  user_id                uuid not null → users(id) on delete cascade
  active_membership_id   uuid not null → memberships(id) on delete cascade
  expires_at             timestamptz not null       TTL — 30 дней sliding
  created_at             timestamptz not null
  last_seen_at           timestamptz not null       throttle: обновляем не чаще раза в минуту
  revoked_at             timestamptz                soft-revoke
  ip                     inet
  user_agent             text
  index (user_id) where revoked_at is null
  index (expires_at) where revoked_at is null       для cleanup-джобы
```

**Cookie:** `HttpOnly`, `Secure` (в prod), `SameSite=Strict`, `Path=/`. Значение — только `session_id`, никаких user-данных внутри.

**Сценарии отзыва — все покрыты автоматически:**

| Событие                        | Механика                                                     |
| ------------------------------ | ------------------------------------------------------------ |
| Юзер logout                    | `UPDATE sessions SET revoked_at=now() WHERE id=?`            |
| Смена пароля                   | `UPDATE sessions SET revoked_at=now() WHERE user_id=?`       |
| Owner уволил сотрудника        | `UPDATE memberships SET status='disabled'` — Гейт 2 отсекает |
| Ручной отзыв конкретной сессии | `UPDATE sessions SET revoked_at=now() WHERE id=?`            |
| Company удалена                | Cascade через `memberships` → sessions невалидны             |
| Session протухла               | `expires_at < now()` — Гейт 1                                |

**Cleanup** протухших/отозванных строк — фоновой джобой (pg-boss или простой interval'ом в бэкапнутый инстанс), раз в час удаляет `revoked_at < now() - interval '30 days' OR expires_at < now() - interval '7 days'`.

### API keys (программный доступ)

Для будущих интеграций (импорт прайсов через API, партнёрские сервисы) вводится отдельный механизм — API keys. Схема закладывается сразу в auth-инкремент, даже если UI для управления ключами появится позже:

```
api_keys
  id            uuid pk
  company_id    uuid not null
  membership_id uuid not null → memberships(id)     кто создал; при disable membership — ключ теряет силу
  name          text                                 "Import bot", "1C sync"
  key_hash      text                                 argon2id-хеш ключа (сам ключ показываем ровно один раз при создании)
  scopes        text[] not null                      ['catalog:read', 'catalog:write', ...]
  expires_at    timestamptz
  last_used_at  timestamptz
  revoked_at    timestamptz
  created_at    timestamptz
```

Запросы с `Authorization: Bearer <key>` проходят те же четыре гейта, но идентичность берётся из `api_keys`, а не из `sessions`. Гейт 2 читает `membership_id` из ключа.

### Аудит-лог

Пишем в `audit_log` на каждом чувствительном действии:

- login (success / fail — с указанием причины: bad password / disabled membership / rate-limit)
- logout, смена пароля
- создание / удаление / переактивация membership, смена роли
- создание / отзыв API-ключа
- удаление company / project / сметы / прайс-листа
- switch-company

Схема:

```
audit_log
  id            uuid pk
  company_id    uuid              для чьей компании событие; null для user-level (например login fail до membership)
  user_id       uuid              subject
  session_id    uuid
  action        text              'auth.login', 'membership.create', 'project.delete', ...
  entity_type   text
  entity_id     uuid
  meta          jsonb             любые доп-детали (ip-если релевантно, причина отказа, старые/новые значения)
  ip            inet
  user_agent    text
  created_at    timestamptz not null
  index (company_id, created_at desc)
  index (user_id, created_at desc)
```

Аудит-лог **на чтение доступен только owner/admin через отдельный endpoint** и защищён теми же четырьмя гейтами.

### Обязательные security-правила

- **Zod-валидация на КАЖДОМ входе.** Ни один хендлер не читает `request.body/query/params` без zod-схемы в route options. Никаких `as any`, никаких `as unknown as X` без крайней нужды.
- **Zod-схема ответа** обязательна для всех доменных эндпоинтов — гарантирует что мы не отдаём наружу поля, которых не должно быть (например, `company_id`, `password_hash`).
- **Ошибки клиенту — без stacktrace, без внутренних деталей.** Единый error handler отдаёт `{ error: { code, message } }`. Полный лог — в бэковый logger.
- **Cross-tenant leak: 404 вместо 403.** Если юзер запросил `/projects/:id` и такого проекта нет **или он не в его компании** — возвращаем `404`, не `403`. Иначе `403` подтверждает, что ресурс существует.
- **SQL injection** — Drizzle параметризует всё автоматически. `sql.raw` — только миграции и тесты, никогда рантайм. Никакой конкатенации строк в запросе.
- **CORS** — жёсткий whitelist через `CORS_ORIGIN`. В `NODE_ENV=production` — только прод-домен фронта. Никаких `*`.
- **Security headers** через `@fastify/helmet`: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, минимальный CSP для API.
- **Rate limit** через `@fastify/rate-limit`:
  - `/api/v1/auth/login`, `/register`, `/reset-password` — 5 попыток/мин на IP + прогрессивная задержка на fail.
  - Остальные — глобальный лимит 300 rpm на IP (тюним по метрикам).
- **Секреты** — только в env. Никогда в коде, никогда в git. `.env` в `.gitignore` с первого коммита.
- **Пароли, session cookies, API-ключи, `Authorization`-заголовки никогда не в логах.** Pino `redact` для этого сконфигурирован (`req.headers.authorization`, `req.headers.cookie`, `req.body.password`, `req.body.token` и т.п.). Смотри `src/app.ts`.
- **Никаких `console.log` с payload'ами.** Только структурированный `request.log` / `app.log`.
- **Никаких «god-mode» эндпоинтов** типа `?company_id=X` для админа. Суперадминка — отдельный сервис в будущем, не хардкод в основном API.
- **HTTPS-only** в проде. Локально HTTP допустим — но cookies с `Secure=false` только через `NODE_ENV !== 'production'` guard.
- **Не логировать** тела ответов доменных эндпоинтов на info-уровне. Только метаданные (route, status, duration, requestId). Дампы — по явной необходимости на debug/trace.

### Тесты изоляции

Обязательное правило: **каждый хендлер, читающий или изменяющий доменные данные, имеет интеграционный тест «cross-tenant isolation»**. Шаблон:

1. Создать компанию A + owner + membership + session.
2. Создать компанию B + owner + membership + доменный ресурс `X` в B.
3. Залогиниться под юзером A.
4. Дёрнуть эндпоинт с `id = X.id`.
5. Ожидать `404` (не `403`, не `500`, не «ok с пустыми данными» — именно `404`).

Также — тест «disabled membership → 401», «expired session → 401», «insufficient role → 403 на mutation».

Тесты — против **реальной Postgres в Docker service container**. **Никаких моков БД.** Причина жёсткая: у продукта был инцидент, где замоканные тесты прошли, а прод-миграция сломалась — с тех пор доменные тесты только против реальной схемы.

---

## Архитектура модулей

Внутри `src/` — модуль-first, а не layer-first.

```
src/
├── index.ts              bootstrap + graceful shutdown
├── app.ts                фабрика Fastify (используется тестами и index.ts)
├── config.ts             zod-парсинг env + version из package.json
├── plugins/              общие плагины: auth, cors, helmet, rate-limit, db, error-handler, withCompanyContext
├── modules/
│   ├── auth/
│   │   ├── routes.ts     регистрация роутов, все с requireRole или явно public
│   │   ├── service.ts    бизнес-логика (регистрация, логин, смена пароля, ротация session)
│   │   ├── repo.ts       Drizzle-запросы к users/memberships/sessions
│   │   └── schema.ts     zod-схемы request/response, экспортятся в @smeteora/shared через ts-rest контракт
│   ├── projects/
│   │   └── ...
│   └── catalog/
│       └── ...
├── db/
│   ├── client.ts         drizzle instance, pool, роль smeteora_app
│   ├── schema.ts         Drizzle table definitions (или разбитый на файлы: users.ts, projects.ts, ...)
│   └── rls.ts            helper для SET LOCAL app.current_company_id
├── lib/                  утилиты общего назначения (errors, ids, dates, arrays)
├── storage/              FileStorage интерфейс + local-реализация
└── routes/               системные (health)
```

**Правила модуля:**

- **`routes.ts`** — только регистрация: URL, метод, schema, preHandler'ы, вызов service. Никакой бизнес-логики, никаких SQL.
- **`service.ts`** — бизнес-логика: последовательности вызовов repo, транзакции, вычисления. Не знает про HTTP.
- **`repo.ts`** — только Drizzle-запросы. Принимает `tx` первым аргументом.
- **`schema.ts`** — zod-схемы, реэкспортятся в `@smeteora/shared` как ts-rest контракт.
- Кросс-модульные вызовы — только через service соседнего модуля. Не лезть в чужой repo напрямую.

### Fastify — плагинная инкапсуляция

- Каждый модуль регистрируется как плагин через `app.register(authModule, { prefix: '/api/v1/auth' })`.
- Плагин **не держит state в модуле** (никаких `let currentUser = ...`). Всё через `request.ctx`, `request.tx`, декораторы app.
- Логирование — только через `request.log` (внутри request-scope) или `app.log` (вне). **Никакого `console.log`** — `no-console` рулит в ESLint.
- **`FastifyPluginAsyncZod`** — тип для роутов с zod type provider. Из него автоматически течёт типизация в handler.
- Хендлеры — **чистые функции**, минимум логики. Всё сложное — в service.
- **Никаких top-level side effects** в модулях. Плагин ничего не делает при импорте, только при `register`.

---

## Zod — валидация на всех входах и выходах

- **`request.body`, `query`, `params`, `headers`** — все проходят через zod-схему в `schema:` опциях роута. Без схемы — не пропускаем в review.
- **Response** — тоже zod-схема (в `schema.response`). Это защита от случайной утечки полей (`company_id`, `password_hash`, внутренние флаги).
- Схема доменного объекта живёт **один раз** в `modules/<name>/schema.ts`. Реэкспортится в `@smeteora/shared` (для фронта) и используется во всех эндпоинтах модуля.
- **Никаких `z.any()`, `z.unknown()`** в местах где данные приходят от клиента. Строгий тип или ошибка валидации.
- Для сложных инвариантов — `.refine(...)` с осмысленным сообщением на русском.
- **Не разбивай одну доменную схему на три «частичные» через `.pick`/`.omit`** без нужды — быстро запутает. Делай отдельные схемы `CreateXInput`, `UpdateXInput`, `XResponse` и явно их поддерживай.

---

## Drizzle — schema-first, forward-only

- Схема таблиц — в `src/db/schema.ts` (или разбитом по файлам).
- Миграции генерируются `drizzle-kit generate` → SQL файлы в `migrations/`. **Только forward.** Никаких «reset базы» в проде, никаких destructive down-миграций.
- Если миграция ломает данные — сначала пишем **backfill-скрипт**, применяем его, потом сносим старую колонку следующей миграцией. Двухфазная выкатка.
- **RLS-политики создаются в миграциях**, как обычный SQL — Drizzle Kit кастомные statements умеет.
- **Транзакции для многошаговых операций.** Если service делает 2+ INSERT/UPDATE, которые должны быть атомарны — оборачивай в `db.transaction`. Особенно: `register` (user + company + membership + session), любое изменение прав.
- **Не строим SQL строковой конкатенацией.** Drizzle параметризует всё. `sql.raw` — только миграции.
- **Не забываем `updated_at`.** Триггер на каждой таблице: `BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION set_updated_at()`.
- **Soft delete** для доменных сущностей: `deleted_at timestamptz`. Все чтения — с `WHERE deleted_at IS NULL`. Partial index.

---

## ts-rest — контракт-first

- Контракт живёт в `@smeteora/shared` (`packages/shared/src/contracts/`). Ровно один источник правды для URL, методов, request/response схем.
- Бэк реализует контракт через `@ts-rest/fastify`.
- Фронт получает автоматически типизированный SDK через `@ts-rest/react-query`.
- Изменение контракта — Breaking → мажорная версия `@smeteora/shared` + одновременный релиз бэка и фронта. Non-breaking (добавление опционального поля) — минорная.
- Публикация — в GitHub Packages по тегу через CI. Локально фронт линкается через workspace (когда будем в монорепо) или через `pnpm link` до первого релиза.

---

## FileStorage — абстракция с первого дня

Все места, которые сохраняют/читают файлы (аватары, аплоад прайс-листов, PDF-сметы) работают через интерфейс:

```ts
interface FileStorage {
  save(
    key: string,
    data: Buffer | Readable,
    meta?: { contentType?: string },
  ): Promise<{ key: string }>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
```

- MVP-реализация — `LocalFileStorage` в `./data/uploads/` (в `.gitignore`).
- Prod-реализация — S3-совместимая (AWS S3 / R2 / MinIO), внедряется тогда когда встанет вопрос деплоя.
- Внедрение — через `app.decorate('storage', ...)`. Хендлеры работают только с `app.storage`, не знают про конкретную реализацию.

---

## API-версионирование

Все доменные роуты — под префиксом `/api/v1/`. С первого эндпоинта.

- Breaking-изменение контракта → **добавляем `/api/v2/`**. Старый работает N месяцев, затем deprecated.
- Non-breaking (добавили опциональное поле в ответ, новый эндпоинт) — остаёмся в `v1`.
- `/healthz` без префикса версии — системный.

---

## Каталог — унифицированный ingestion pipeline

Каталог товаров поддерживает несколько способов загрузки: ручной upload CSV/XLSX, программный доступ через API, в будущем — 1C CommerceML XML, PDF (через LLM-extraction), webhook от партнёрских систем.

**Все эти каналы сходятся в один внутренний pipeline:**

```
источник → adapter → parsed rows → mapper (для файлов) → normalized rows → zod validate → upsert (products)
                                                                                    ↓
                                                                        price_list_uploads.summary
```

- Валидация и upsert едины для всех источников. Нельзя обойти проверки через какой-то один канал.
- Добавить формат = один новый adapter, всё остальное не трогаем.
- `price_list_uploads.source` фиксирует канал (`manual_upload | api | 1c_xml | pdf_ocr`), `source_metadata jsonb` хранит специфику канала.

**Products с nullable `company_id`:**

- `source='company'` + `company_id=<X>` → товар компании X, виден только ей.
- `source='platform'` + `company_id=NULL` → наш платформенный товар, виден всем через RLS-политику `... OR company_id IS NULL`.
- Платформенные товары создаёт роль `smeteora_platform_editor`. Рантайм-роль `smeteora_app` физически не может создать строку с `company_id=NULL`.

Дальнейшие детали (mapper UI, presets, unit reference) — в CLAUDE.md соответствующего инкремента.

---

## Обработка ошибок

- Иерархия типизированных ошибок в `src/lib/errors.ts`:
  ```ts
  export class DomainError extends Error { readonly code: string; readonly statusCode: number; }
  export class NotFoundError extends DomainError { ... code='not_found', statusCode=404 }
  export class ForbiddenError extends DomainError { ... code='forbidden', statusCode=403 }
  export class ValidationError extends DomainError { ... code='validation', statusCode=400 }
  export class ConflictError extends DomainError { ... code='conflict', statusCode=409 }
  ```
- Service бросает типизированную ошибку. Единый error handler в `app.ts` маппит её на HTTP-ответ.
- **Не логируем ошибку 2 раза.** Логгирование — только в error handler. Не пиши `logger.error(...); throw ...` — оба лога всплывут.
- **Наружу — только `{ error: { code, message } }`.** Никакого stacktrace в production. В dev — можно (для отладки).
- **Не глотай ошибки** тихо: `try { ... } catch { return null }` без логирования — запрещено. Либо логируешь и продолжаешь (с пометкой warn), либо пробрасываешь.

---

## Логирование — Pino

- Логгер = встроенный Fastify (Pino).
- **`request.log`** внутри request-scope (автоматически прицепляет `requestId`, `method`, `url`).
- **`app.log`** — только вне request'а (bootstrap, background jobs).
- **`console.log` запрещён ESLint-правилом.** Только `console.warn`/`error` для системных вещей до инициализации логгера.
- **Redact-конфиг** — в `src/app.ts`. При добавлении нового чувствительного поля (`req.body.newSecret`) — сразу добавляй в `REDACT_PATHS`.
- **Не логируем полные тела ответов** доменных эндпоинтов на info. Только метаданные. Дампы — на debug/trace, включаются переменной `LOG_LEVEL=debug` вручную.
- Формат в dev — pino-pretty (читабельно), в prod — JSON (для aggregation).

---

## Тесты — Vitest против реальной Postgres

- **Никаких моков БД.** У продукта был инцидент: замоканные тесты прошли, прод-миграция сломалась. С тех пор — только реальная база.
- Локально — Postgres через docker-compose. В CI — Postgres service container.
- Каждый тест-файл использует свою **схему** в общей БД или **чистит таблицы после себя** через `TRUNCATE ... CASCADE`. Изоляция обязательна — параллельные тесты не должны видеть друг друга.
- **Обязательные категории тестов** для каждого доменного модуля:
  1. Happy path (create/read/update/delete).
  2. **Cross-tenant isolation** — юзер компании А не видит ресурсы компании Б → `404`.
  3. **Role gate** — viewer не может POST/DELETE → `403`.
  4. **Session gate** — expired / revoked session → `401`.
  5. **Membership disabled** → `401` на любой доменный запрос.
- Fixtures — helper'ы `createCompany`, `createUserWithMembership`, `login(user)` в `test/helpers/`. Не копипастим 30 строк setup'а в каждом тесте.
- **Не гоняем тесты через одну общую auth-сессию** между разными cases. Каждый case создаёт своих юзеров и session'ы — иначе race conditions.

---

## Env / секреты

- Все переменные окружения — в `.env.example` с пустыми/дефолтными значениями и комментарием.
- Реальный `.env` — только локально, в `.gitignore`. Не коммитим никогда.
- В prod — через GitHub Secrets / переменные хостинга.
- **Парсим env один раз при старте** через `configSchema` в `src/config.ts`. Если невалидно — падаем с внятной ошибкой, не запускаем сервер с кривыми настройками.
- `process.env` больше нигде в коде не читается напрямую — только через `app.config`.

---

## Работа с БД в разработке

- **Локальный Postgres** — через `docker compose up -d postgres postgres-test`. Основная БД на порту 5442 (5432 занят другими проектами пользователя), тестовая на 5433.
- **Миграции запускаются под ролью `smeteora_migrator`** (BYPASSRLS + CREATEDB). Приложение работает под `smeteora_app` (без BYPASSRLS) — гарантия что баг в SQL не сможет обойти RLS.
- `DATABASE_URL` в env — обязательно указывает на app-роль. `DATABASE_URL_MIGRATOR` — отдельная переменная, только для скриптов миграции.
- **Добавляешь новую доменную таблицу — обязательно:**
  1. `company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE`
  2. Индекс на `company_id`
  3. `created_at`, `updated_at` с триггером `set_updated_at()`
  4. `deleted_at timestamptz` + partial index `WHERE deleted_at IS NULL` (если soft-delete применим)
  5. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + политика с `NULLIF(current_setting('app.current_company_id', true), '')::uuid`
  6. `GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO smeteora_app`
  7. Интеграционный тест cross-tenant isolation по образу `test/rls-isolation.test.ts`

## Миграции — forward-only

- Миграции генерируются `drizzle-kit generate`. Ревьюим SQL перед коммитом — Drizzle иногда генерирует лишнее.
- **Только вперёд.** Никаких down-миграций в проде. Если нужно откатить — новая forward-миграция, откатывающая изменение.
- Разрушительные изменения (drop column, rename с потерей данных) — **двухфазно**:
  1. Первая миграция: добавили новую колонку / таблицу, backfill-скрипт заполняет её.
  2. Приложение переезжает читать/писать по новой схеме.
  3. Вторая миграция (следующий релиз): сносим старое.
- **RLS-политики** — тоже в миграциях. Не создаются кодом при старте — иначе легко разъедутся с схемой.
- **Никаких `db:reset`, `db:drop`** в скриптах пакета в prod-режиме. Только dev.
- Пересоздание БД в dev — руками через docker-compose down/up.

---

## Комментарии

- **Все комментарии — на русском.**
- Default to writing no comments. Пиши комментарий только когда **зачем** неочевидно: скрытое ограничение, неявный инвариант, обход конкретного бага, поведение которое удивит читателя. Не описывай **что** делает код — это видно.
- Не оставляй ссылок на текущую задачу / PR / автора / issue-номер — они устаревают быстрее чем код.
- **Никаких упоминаний AI / Claude / GPT / Copilot** в коде, комментариях, коммитах, PR, README. Ни `Co-Authored-By: Claude`, ни `🤖 Generated with ...`, ни в метаданных. Авторство обычное человеческое.

---

## TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- **Никакого `any`.** `unknown` + narrowing если правда неизвестен тип.
- **Никаких TypeScript `enum`** — используем `as const` объекты или union literal type + map.
  ```ts
  const ROLES = ['viewer', 'member', 'admin', 'owner'] as const;
  type Role = (typeof ROLES)[number];
  ```
- **`import type`** для чисто типовых импортов (enforced ESLint правилом).
- Доменные типы — генерируются из Drizzle-схемы (`typeof usersTable.$inferSelect`) + доп-типы в `@smeteora/shared` для API.
- Props / options интерфейсов — `type X = { ... }`, не `interface` (единообразие).

---

## Никаких магических чисел и строк

- Любая константа со значением, которое не очевидно из контекста — **именуется**. `1000 * 60 * 60 * 24 * 30` → `SESSION_TTL_MS`, `12` → `PASSWORD_MIN_LENGTH`, `5` → `LOGIN_ATTEMPTS_PER_MINUTE`.
- Массивы допустимых значений — один раз, `as const`, тянем оттуда.
- Map'ы (роль → минимальная роль, статус → человекочитаемое) — типизированный `Record<Role, T>`. Ключи из union type, не свободные строки. TS падает если добавили новый вариант и забыли смапить.

---

## Внешние HTTP-запросы — AbortController + таймаут

Любой запрос к внешнему API обязан иметь `AbortController` с потолком:

```ts
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
try {
  const res = await fetch(url, { signal: ctrl.signal });
  if (!res.ok) throw new ExternalApiError(`HTTP ${res.status} from ${url}`);
  return await res.json();
} finally {
  clearTimeout(timer);
}
```

Потолки: probe — 4-5s; обычный CRUD — 8-10s; тяжёлый отчёт — 15-30s. **Без таймаута — не мержим.**

---

## Коммиты и PR

- Ветки: `feat/<short>`, `fix/<short>`, `chore/<short>`, `refactor/<short>`.
- Коммиты — **Conventional Commits** (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`), проверяется commitlint.
- Pre-commit: `eslint --fix` + `prettier --write` через lint-staged.
- PR проходит: `pnpm lint && pnpm type-check && pnpm test && pnpm build` без предупреждений.
- Каждый доменный PR содержит **cross-tenant isolation тест** для изменённого/добавленного эндпоинта — иначе не мержится.
- **Никаких упоминаний AI/Claude/GPT/Copilot** в коммитах, PR, коде, комментариях, README. Всё авторство — обычное человеческое.

---

## Чего не делать

- Не давать доменные эндпоинты без `preHandler: requireRole(...)`.
- Не читать `request.body` без zod-схемы.
- Не отдавать доменные объекты без zod-схемы ответа (утечёт лишнее).
- Не делать `db.select().from(projects)` вне транзакции с `SET LOCAL app.current_company_id`.
- Не пропускать cross-tenant isolation тест.
- Не мокать БД в тестах.
- Не хардкодить секреты, `CORS_ORIGIN`, лимиты — только через env.
- Не отдавать stacktrace наружу в prod.
- Не логировать пароли, cookies, session-id, API-keys, `Authorization`-заголовки.
- Не использовать `console.log` (ESLint не пропустит).
- Не писать down-миграции с расчётом на прод.
- Не строить SQL конкатенацией — Drizzle параметризует.
- Не создавать «god-mode» эндпоинты типа `?company_id=X` для админа.
- Не забывать `AbortController` + таймаут на внешний fetch.
- Не подписывать коммиты `Co-Authored-By: Claude` — авторство обычное человеческое.
- Не делать эндпоинт под серьёзное действие идемпотентным «на всякий случай» — если пользователь дважды нажал «удалить», это его выбор; второй запрос вернёт 404, это правильно.
- Не откладывать `updated_at` триггер на «потом» — он на каждой таблице сразу.
