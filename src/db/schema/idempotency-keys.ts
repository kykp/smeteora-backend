import { pgTable, uuid, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Кэш идемпотентности для мутирующих HTTP-запросов. Клиент шлёт заголовок
// Idempotency-Key: <uuid> — сервер при первом запросе применяет мутацию и
// сохраняет тело ответа. Повторный запрос с тем же ключом (двойной клик,
// ретрай при таймауте) возвращает сохранённый ответ, ничего не применяя
// повторно.
//
// Не под RLS: ключи содержат ответы разных компаний, но лукап всегда по
// уникальному uuid — коллизии почти невозможны. Дополнительно храним
// company_id + user_id для ретеншена и аудита («под кем этот ключ»).
//
// Retention: 24 часа хватает под любые сетевые ретраи. Cleanup — фоновая
// задача (см. src/lib/idempotency.ts).
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: uuid('key').primaryKey(),
    companyId: uuid('company_id').notNull(),
    userId: uuid('user_id').notNull(),
    // Метод + путь, чтобы один и тот же ключ не пересекался между разными
    // эндпоинтами (клиент шлёт uuid, теоретически может повторить его на
    // другом POST — мы вернём 409, а не «случайный» кэш).
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idempotency_keys_created_idx').on(t.createdAt)],
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;

// SQL для инициализации: включаем table в схему через ре-экспорт после того,
// как /db/schema/index.ts подцепит.
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;
export const IDEMPOTENCY_CLEANUP_SQL = sql`
  DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'
`;
