import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { users } from './users.js';
import { MEMBERSHIP_STATUSES, ROLES } from '../constants.js';

// Единственный источник правды о том, кто в какой компании и с какой ролью.
// Один юзер может быть в нескольких компаниях (сотрудник + консультант).
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ROLES }).notNull(),
    status: text('status', { enum: MEMBERSHIP_STATUSES }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memberships_user_company_unique_idx').on(t.userId, t.companyId),
    index('memberships_company_idx').on(t.companyId),
    index('memberships_user_active_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
