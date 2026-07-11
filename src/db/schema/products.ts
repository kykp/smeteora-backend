import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { productCategories } from './product-categories.js';
import { units } from './units.js';
import { CATALOG_SOURCES, LINE_ITEM_KINDS } from '../constants.js';

// Товары каталога. Nullable company_id — платформенные видны всем через RLS.
// Цена numeric(14,4) как в line_items — сохраняем точность до сотых копейки,
// одинаково для рекомендованной цены здесь и для позиции в смете.
//
// attributes JSONB — гибкие доменные признаки (разрешение камеры, категория кабеля,
// тип матрицы). Позволяет добавлять фильтры без миграций. Если потом понадобится
// строгий типизированный поиск — вытащим в normalizirovan-таблицу.
//
// is_active — soft-скрыть товар из подсказок в редакторе смет без удаления
// (в старых сметах ссылка на него сохранится).
export const products = pgTable(
  'products',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    source: text('source', { enum: CATALOG_SOURCES }).notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => productCategories.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    sku: text('sku'),
    brand: text('brand'),
    description: text('description'),
    // Тип позиции при добавлении в смету: material (оборудование/материалы),
    // work (монтаж/работы), service (услуги), other (прочие расходы).
    // Значение копируется в line_item.kind при добавлении, юзер может
    // переопределить в строке. Дефолт material — большинство товаров каталога
    // это оборудование.
    kind: text('kind', { enum: LINE_ITEM_KINDS }).notNull().default('material'),

    buyPrice: numeric('buy_price', { precision: 14, scale: 4 }),
    sellPrice: numeric('sell_price', { precision: 14, scale: 4 }),

    attributes: jsonb('attributes')
      .notNull()
      .default(sql`'{}'::jsonb`),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('products_company_idx').on(t.companyId),
    index('products_category_active_idx')
      .on(t.categoryId, t.name)
      .where(sql`${t.deletedAt} IS NULL AND ${t.isActive} = true`),
    index('products_brand_idx')
      .on(t.brand)
      .where(sql`${t.deletedAt} IS NULL`),
    // Уникальный SKU в пределах компании / платформы.
    uniqueIndex('products_company_sku_unique')
      .on(t.companyId, t.sku)
      .where(sql`${t.deletedAt} IS NULL AND ${t.sku} IS NOT NULL`),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
