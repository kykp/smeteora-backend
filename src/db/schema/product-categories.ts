import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { CATALOG_SOURCES } from '../constants.js';

// Категории каталога. Nullable company_id = поддержка platform-контента
// (наши глобальные категории видны всем). Своя категория компании — company_id
// не null. RLS-политика в миграции: company_id = current OR company_id IS NULL.
//
// parent_id даёт древовидность (Видеонаблюдение → Купольные камеры). Пока UI
// плоский, но схема готова.
//
// code — машинный ключ ('video', 'video/dome-cams'), стабильный между релизами.
// Именно по нему фронт мапится на семантику и иконки.
export const productCategories = pgTable(
  'product_categories',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    source: text('source', { enum: CATALOG_SOURCES }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => productCategories.id, {
      onDelete: 'cascade',
    }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('product_categories_company_idx').on(t.companyId),
    index('product_categories_parent_idx').on(t.parentId),
    // Уникальный code в пределах scope (платформа отдельно, каждая компания отдельно).
    uniqueIndex('product_categories_company_code_unique')
      .on(t.companyId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export type ProductCategory = typeof productCategories.$inferSelect;
export type NewProductCategory = typeof productCategories.$inferInsert;
