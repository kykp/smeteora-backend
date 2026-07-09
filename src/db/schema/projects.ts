import { pgTable, uuid, text, timestamp, date, integer, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { PROJECT_STATUSES } from '../constants.js';

// Первая доменная сущность. Живёт под RLS: политика projects_tenant_isolation
// отсекает всё что не company_id = current_setting('app.current_company_id').
export const projects = pgTable(
  'projects',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    address: text('address'),
    clientName: text('client_name'),
    clientPhone: text('client_phone'),
    status: text('status', { enum: PROJECT_STATUSES }).notNull().default('draft'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    // Прикладные метрики монтажников. Все опциональны — заполняются в
    // модалке параметров проекта; NULL = «не указано», в UI показываем как 0.
    siteObject: text('site_object'),
    areaM2: integer('area_m2'),
    camerasCount: integer('cameras_count'),
    equipmentBrand: text('equipment_brand'),
    budgetRub: integer('budget_rub'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('projects_company_idx').on(t.companyId),
    index('projects_company_active_idx')
      .on(t.companyId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    index('projects_company_status_idx')
      .on(t.companyId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
