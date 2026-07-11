import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
  index,
  uniqueIndex,
  char,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { memberships } from './memberships.js';
import {
  ESTIMATE_MODES,
  ESTIMATE_STATUSES,
  LINE_ITEM_KINDS,
  PRICE_BASES,
  TAX_BASE_KINDS,
  TAX_REGIMES,
  VAT_MODES,
} from '../constants.js';

// ── estimates (шапка сметы) ────────────────────────────────────────
// Смета всегда принадлежит проекту, project_id NOT NULL. Через проект → компания;
// но company_id дублируется явно для скорости RLS (политика проверяет одну колонку
// без JOIN на projects).
//
// vat_mode + vat_rate — параметры расчёта по всей смете. У позиции есть override
// на случай многоставочного НДС.
//
// Скидка задаётся ЛИБО процентом ЛИБО суммой (взаимоисключимо на уровне контракта).
//
// meta jsonb — задел под нестандартные данные (шаблон, теги, интеграции).
export const estimates = pgTable(
  'estimates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: text('number'),
    title: text('title').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('RUB'),
    vatMode: text('vat_mode', { enum: VAT_MODES }).notNull().default('none'),
    vatRate: numeric('vat_rate', { precision: 5, scale: 2 }),
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }),
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }),
    status: text('status', { enum: ESTIMATE_STATUSES }).notNull().default('draft'),
    // Режим редактирования: simple — плоский список; pro — разделы с наценкой.
    // Модель данных одна и та же, различается только UI. Дефолт 'simple' —
    // новички работают с более понятным интерфейсом; кто хочет — переключит.
    mode: text('mode', { enum: ESTIMATE_MODES }).notNull().default('simple'),
    // Налоговый режим сметы. Считается на клиенте по стандартной формуле
    // (см. constants.TAX_REGIMES). tax_rate/tax_base_kind нужны только для
    // 'custom' — иначе игнорируются.
    taxRegime: text('tax_regime', { enum: TAX_REGIMES }).notNull().default('none'),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }),
    taxBaseKind: text('tax_base_kind', { enum: TAX_BASE_KINDS }),
    notes: text('notes'),
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Optimistic concurrency: инкрементится на каждую мутацию (шапка, строка,
    // раздел). Клиент шлёт If-Match с текущим значением, при расхождении
    // сервис возвращает 409. Без этого двое юзеров затирают правки друг друга.
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('estimates_company_idx').on(t.companyId),
    index('estimates_project_active_idx')
      .on(t.companyId, t.projectId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    index('estimates_company_status_idx')
      .on(t.companyId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);
export type Estimate = typeof estimates.$inferSelect;
export type NewEstimate = typeof estimates.$inferInsert;

// ── estimate_sections (разделы сметы) ─────────────────────────────
// parent_id — задел под tree; в MVP всегда null. Реализуем плоскую структуру,
// но колонка есть, чтобы миграция в дерево прошла аддитивно.
export const estimateSections = pgTable(
  'estimate_sections',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id').notNull(),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => estimateSections.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    // Наценка раздела в процентах. При добавлении позиции в раздел
    // sellPrice = buyPrice × (1 + margin/100). null = наценка не применяется
    // автоматом; юзер должен вводить цену явно. Диапазон 0..1000%.
    defaultMarginPercent: numeric('default_margin_percent', { precision: 6, scale: 2 }),
    // Скидка раздела в процентах (для simple-режима). Применяется ко всем
    // строкам раздела у которых custom_discount_percent IS NULL — при
    // изменении бэк пересчитывает их цены. Диапазон 0..100%.
    defaultDiscountPercent: numeric('default_discount_percent', { precision: 5, scale: 2 }),
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('estimate_sections_estimate_idx').on(t.estimateId, t.sortOrder),
    index('estimate_sections_parent_idx').on(t.estimateId, t.parentId, t.sortOrder),
    index('estimate_sections_company_idx').on(t.companyId),
  ],
);
export type EstimateSection = typeof estimateSections.$inferSelect;
export type NewEstimateSection = typeof estimateSections.$inferInsert;

// ── estimate_line_items (позиции) ─────────────────────────────────
// section_id — nullable, позиция может лежать вне раздела.
// product_id — задел под каталог. Пока без FK constraint (таблица products не создана).
// catalog_snapshot — при добавлении из каталога фиксируем цену/название на момент,
// чтобы смена цены в каталоге не переписывала историческую смету.
export const estimateLineItems = pgTable(
  'estimate_line_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id').notNull(),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').references(() => estimateSections.id, { onDelete: 'set null' }),
    productId: uuid('product_id'),
    catalogSnapshot: jsonb('catalog_snapshot'),
    kind: text('kind', { enum: LINE_ITEM_KINDS }).notNull().default('work'),
    name: text('name').notNull(),
    unit: text('unit').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 4 }).notNull(),
    price: numeric('price', { precision: 14, scale: 4 }).notNull(),
    // Себестоимость единицы. Используется калькулятором рентабельности.
    // Для товаров/работ из каталога дублирует snapshot.buyPrice/cost и
    // юзер её обычно не трогает. Для manual (раздел «Другое») юзер задаёт
    // руками — иначе не отличить транзитную командировку от наценки.
    // 0 = «расход клиенту 1:1» (маржи нет).
    cost: numeric('cost', { precision: 14, scale: 4 }).notNull().default('0'),
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    vatRateOverride: numeric('vat_rate_override', { precision: 5, scale: 2 }),
    // Override наценки на этой строке. Используется когда price_basis='cost'.
    // null = наследуется от раздела (estimate_sections.default_margin_percent).
    customMarginPercent: numeric('custom_margin_percent', { precision: 6, scale: 2 }),
    // Override скидки на этой строке (simple-режим). null = наследует от
    // раздела (estimate_sections.default_discount_percent). При изменении
    // скидки раздела строки с override своё значение сохраняют.
    customDiscountPercent: numeric('custom_discount_percent', { precision: 5, scale: 2 }),
    // База расчёта цены. Определяет как считается price:
    //   rrp    → price = snapshot.sellPrice × (1 - discountPercent/100)
    //   cost   → price = snapshot.buyPrice × (1 + effectiveMargin/100)
    //   manual → price вводится вручную, ни discount ни margin не применяются.
    priceBasis: text('price_basis', { enum: PRICE_BASES }).notNull().default('rrp'),
    // Категория расхода для позиций kind='other' (транспорт, проектирование,
    // командировочные). Используется в разделе «Другое» и в аналитике —
    // группировка «сколько ушло на транспорт за квартал». Свободный text,
    // валидность значения проверяет клиент по списку EXPENSE_CATEGORIES.
    expenseCategory: text('expense_category'),
    sortOrder: integer('sort_order').notNull().default(0),
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('estimate_items_estimate_idx').on(t.estimateId, t.sectionId, t.sortOrder),
    index('estimate_items_company_idx').on(t.companyId),
    index('estimate_items_product_idx')
      .on(t.productId)
      .where(sql`${t.productId} IS NOT NULL`),
  ],
);
export type EstimateLineItem = typeof estimateLineItems.$inferSelect;
export type NewEstimateLineItem = typeof estimateLineItems.$inferInsert;

// ── estimate_versions (snapshot истории) ──────────────────────────
// Immutable-снапшот дерева на моменте перехода статуса (например draft→sent).
// В MVP таблица создаётся, но эндпоинт "отправить клиенту" ещё не реализован —
// колонки готовы, а логика snapshot'а появится позже без миграции схемы.
export const estimateVersions = pgTable(
  'estimate_versions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id').notNull(),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by').references(() => memberships.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('estimate_versions_estimate_number_idx').on(t.estimateId, t.versionNumber),
    index('estimate_versions_company_idx').on(t.companyId),
  ],
);
export type EstimateVersion = typeof estimateVersions.$inferSelect;
export type NewEstimateVersion = typeof estimateVersions.$inferInsert;
