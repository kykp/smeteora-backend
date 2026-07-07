import { pgTable, uuid, text, timestamp, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Справочник единиц измерения. Строго платформенный (без company_id) —
// база у всех одна и та же, компаниям не даём заводить свои единицы
// на MVP, иначе смет юзер А не сможет сравнивать с сметами юзера Б.
// Если понадобится расширение — миграция добавит nullable company_id.
export const units = pgTable(
  'units',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Машинный код, стабильный между релизами. Фронт может форматировать по коду.
    code: text('code').notNull(),
    // Человеко-читаемое короткое: 'шт', 'м', 'к-т'.
    shortName: text('short_name').notNull(),
    // Полное название: 'штука', 'метр', 'комплект'.
    fullName: text('full_name').notNull(),
    // Для сортировки в UI-селекторе.
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('units_code_unique').on(t.code)],
);

export type Unit = typeof units.$inferSelect;
export type NewUnit = typeof units.$inferInsert;
