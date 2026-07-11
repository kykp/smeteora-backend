import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { CATALOG_SOURCES } from '../constants.js';

// Категории каталога монтажных работ. Плоский справочник (parent_id нет —
// в отличие от product_categories, работам глубокое дерево не нужно: у
// монтажной компании их обычно 3-5 штук). Nullable company_id — можем
// раздавать платформенные категории всем через RLS.
//
// code — стабильный машинный ключ («cabling», «install», «commissioning»),
// не меняется между релизами; UI-иконки и логика мапятся по нему.
export const workCategories = pgTable(
  'work_categories',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    source: text('source', { enum: CATALOG_SOURCES }).notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('work_categories_company_idx').on(t.companyId),
    uniqueIndex('work_categories_company_code_unique')
      .on(t.companyId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export type WorkCategory = typeof workCategories.$inferSelect;
export type NewWorkCategory = typeof workCategories.$inferInsert;
