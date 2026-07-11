import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { workCategories } from './work-categories.js';
import { units } from './units.js';
import { CATALOG_SOURCES } from '../constants.js';

// Позиции каталога монтажных работ. В отличие от products, тут одна цена
// (не РРЦ/закупка) — расценка компании за единицу работы. Модель приходится
// не «купить-продать», а «мы делаем это — стоит N ₽ за единицу».
//
// Позиция при добавлении в смету всегда получает kind='work' и падает в
// раздел «Монтаж». meta jsonb — задел под коэффициенты (высотные, ночные,
// срочные) на будущее без миграции.
export const workItems = pgTable(
  'work_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    source: text('source', { enum: CATALOG_SOURCES }).notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => workCategories.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    description: text('description'),
    // Расценка за единицу — сколько берём с клиента. Null допустим —
    // «работа заведена, цена ещё не проставлена» (частый онбординговый
    // кейс с пресетом).
    price: numeric('price', { precision: 14, scale: 4 }),
    // Себестоимость: что мы платим бригаде / субподрядчику / сами тратим
    // на эту работу. Отдельно от price, чтобы аналитика видела маржу
    // (price - cost) на работах, а не только на оборудовании. Null =
    // «не заведена».
    cost: numeric('cost', { precision: 14, scale: 4 }),

    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),

    // Автопривязка: если в смету добавляется товар из категории из этого
    // массива — эта работа добавляется автоматом (qty=1, или +1 к существующей
    // строке). Пустой массив = нет автопривязки. GIN-индекс в миграции —
    // для быстрого @> поиска при добавлении товара.
    triggerCategoryIds: uuid('trigger_category_ids')
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('work_items_company_idx').on(t.companyId),
    index('work_items_category_active_idx')
      .on(t.categoryId, t.name)
      .where(sql`${t.deletedAt} IS NULL AND ${t.isActive} = true`),
  ],
);

export type WorkItem = typeof workItems.$inferSelect;
export type NewWorkItem = typeof workItems.$inferInsert;
