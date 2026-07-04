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
import { ESTIMATE_STATUSES, LINE_ITEM_KINDS, VAT_MODES } from '../constants.js';

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
    notes: text('notes'),
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    vatRateOverride: numeric('vat_rate_override', { precision: 5, scale: 2 }),
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
